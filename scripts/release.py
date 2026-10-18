#!/usr/bin/env python3
"""Build and verify Bob packages; finalize appcast only after checking GitHub."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.request import Request, urlopen
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_FILES = ('info.json', 'main.js', 'lib/models.js', 'lib/request.js')
VERSION_PATTERN = re.compile(r'^\d+\.\d+\.\d+$')
SHA_PATTERN = re.compile(r'^[0-9a-f]{64}$')
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
REQUIRE_PATTERN = re.compile(r'''\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)''')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def version_tuple(version):
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise ValueError('Version must be numeric major.minor.patch: %r' % version)
    return tuple(map(int, version.split('.')))


def release_filename(info):
    return 'gemini-tts-%s.bobplugin' % info['version']


def repository(info):
    match = re.fullmatch(r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?', info['homepage'])
    if not match:
        raise ValueError('homepage must be a GitHub repository URL')
    return '/'.join(match.groups())


def release_url(info, version=None):
    version = version or info['version']
    return 'https://github.com/%s/releases/download/v%s/gemini-tts-%s.bobplugin' % (
        repository(info), version, version)


def validate_feed(feed, info):
    if not isinstance(feed, dict) or feed.get('identifier') != info['identifier']:
        raise ValueError('appcast identifier does not match info.json')
    versions = feed.get('versions')
    if not isinstance(versions, list):
        raise ValueError('appcast versions must be an array')
    previous = None
    for entry in versions:
        current = version_tuple(entry['version'])
        if previous is not None and current >= previous:
            raise ValueError('appcast versions must be unique and ordered newest first')
        previous = current
        if not isinstance(entry.get('sha256'), str) or not SHA_PATTERN.fullmatch(entry['sha256']):
            raise ValueError('appcast contains an invalid SHA-256')
        if entry.get('url') != release_url(info, entry['version']):
            raise ValueError('appcast asset URL does not match its version')
        version_tuple(entry['minBobVersion'])
        if type(entry.get('timestamp')) is not int or entry['timestamp'] <= 0:
            raise ValueError('appcast timestamp must be positive UTC epoch milliseconds')
        if not isinstance(entry.get('desc'), str) or not entry['desc'].strip():
            raise ValueError('appcast release description is missing')
        if entry['version'] == info['version'] and entry['minBobVersion'] != info['minBobVersion']:
            raise ValueError('appcast minBobVersion does not match info.json')
    if versions and version_tuple(versions[0]['version']) > version_tuple(info['version']):
        raise ValueError('info.json is older than the published appcast')


def check_source(root):
    root = Path(root).resolve()
    info = read_json(root / 'info.json')
    version_tuple(info['version'])
    version_tuple(info['minBobVersion'])
    if info.get('identifier') != 'bob-plugin-gemini-tts':
        raise ValueError('The published legacy identifier must be preserved')
    repository(info)
    identifiers = set()
    for option in info['options']:
        if option['identifier'] in identifiers:
            raise ValueError('Duplicate option identifier')
        identifiers.add(option['identifier'])
        if option['type'] == 'menu' and option['defaultValue'] not in [
                item['value'] for item in option['menuValues']]:
            raise ValueError('Menu default is not an available value')
    for name in RUNTIME_FILES:
        source_path = root / name
        if not source_path.is_file() or source_path.is_symlink():
            raise ValueError('Missing or symlinked runtime file: ' + name)
        if name.endswith('.js'):
            for match in REQUIRE_PATTERN.finditer(source_path.read_text(encoding='utf-8')):
                dependency = (source_path.parent / match.group(2)).resolve()
                if not dependency.suffix:
                    dependency = dependency.with_suffix('.js')
                try:
                    relative = dependency.relative_to(root).as_posix()
                except ValueError:
                    raise ValueError('A runtime module requires a file outside the plugin')
                if relative not in RUNTIME_FILES:
                    raise ValueError('Runtime dependency is missing from package manifest: ' + relative)
    validate_feed(read_json(root / 'appcast.json'), info)
    return info


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        output.write(data)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def artifact_hash(artifact):
    return hashlib.sha256(Path(artifact).read_bytes()).hexdigest()


def build_package(root, output_dir):
    root, output_dir = Path(root), Path(output_dir)
    info = check_source(root)
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact = output_dir / release_filename(info)
    with tempfile.NamedTemporaryFile(dir=output_dir, delete=False) as output:
        temporary = Path(output.name)
    try:
        # The runtime is small. Stored entries also keep bytes identical across
        # Python/zlib versions and operating systems, not just across file mtimes.
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED) as package:
            for name in RUNTIME_FILES:
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_STORED
                package.writestr(entry, (root / name).read_bytes())
        temporary.replace(artifact)
    finally:
        temporary.unlink(missing_ok=True)
    verify_package(root, artifact)
    atomic_write(artifact.with_suffix(artifact.suffix + '.sha256'),
                 ('%s  %s\n' % (artifact_hash(artifact), artifact.name)).encode('ascii'))
    return artifact


def verify_package(root, artifact, appcast=None):
    root, artifact = Path(root), Path(artifact)
    info = check_source(root)
    if artifact.name != release_filename(info) or artifact.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('Artifact filename or size is invalid')
    with zipfile.ZipFile(artifact) as package:
        if sorted(package.namelist()) != sorted(RUNTIME_FILES):
            raise ValueError('Archive must contain exactly the runtime manifest, without duplicates')
        for entry in package.infolist():
            file_type = (entry.external_attr >> 16) & 0o170000
            if file_type not in (0, 0o100000) or entry.flag_bits & 1:
                raise ValueError('Archive contains a non-regular or encrypted runtime file')
            expected = (root / entry.filename).read_bytes()
            if entry.file_size != len(expected) or package.read(entry) != expected:
                raise ValueError('Archive content differs from source: ' + entry.filename)
    if appcast is not None:
        feed = read_json(appcast)
        validate_feed(feed, info)
        if not feed['versions'] or feed['versions'][0]['version'] != info['version']:
            raise ValueError('Release appcast must start with the package version')
        if feed['versions'][0]['sha256'] != artifact_hash(artifact):
            raise ValueError('appcast SHA-256 does not match the built artifact')
    return info


def read_url(url, limit, api=False):
    headers = {'User-Agent': 'bob-plugin-gemini-tts-release'}
    if api:
        headers['Accept'] = 'application/vnd.github+json'
        if os.environ.get('GITHUB_TOKEN'):
            headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    # The browser asset download carries no token, including after redirects.
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('GitHub response exceeds the size limit')
    return data


def verify_github(info, artifact):
    tag = 'v' + info['version']
    url = 'https://api.github.com/repos/%s/releases/tags/%s' % (repository(info), tag)
    release = json.loads(read_url(url, 2 * 1024 * 1024, api=True))
    if release.get('tag_name') != tag or release.get('draft') or release.get('prerelease'):
        raise ValueError('GitHub tag must have a published, non-prerelease Release')
    assets = [item for item in release.get('assets', []) if item.get('name') == artifact.name]
    if len(assets) != 1 or assets[0].get('browser_download_url') != release_url(info):
        raise ValueError('GitHub Release does not contain the expected versioned asset')
    if assets[0].get('size') != artifact.stat().st_size:
        raise ValueError('GitHub asset size differs from the local artifact')
    digest = artifact_hash(artifact)
    if assets[0].get('digest') and assets[0]['digest'] != 'sha256:' + digest:
        raise ValueError('GitHub asset digest differs from the local artifact')
    remote = read_url(assets[0]['browser_download_url'], MAX_ARCHIVE_BYTES)
    if hashlib.sha256(remote).hexdigest() != digest:
        raise ValueError('Downloaded GitHub asset SHA-256 differs from the local artifact')
    published_at = release.get('published_at')
    if not isinstance(published_at, str):
        raise ValueError('GitHub Release has no publication time')
    published = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
    if published.tzinfo is None:
        raise ValueError('GitHub publication time must include a timezone')
    return int(published.timestamp() * 1000)


def prepare_appcast(root, artifact, notes_file, timestamp):
    root, artifact = Path(root), Path(artifact)
    info = verify_package(root, artifact)
    description = Path(notes_file).read_text(encoding='utf-8').strip()
    if not description or len(description) > 3000:
        raise ValueError('Release notes must contain 1–3000 characters')
    feed = read_json(root / 'appcast.json')
    digest = artifact_hash(artifact)
    for entry in feed['versions']:
        if entry['version'] == info['version'] and entry['sha256'] != digest:
            raise ValueError('Cannot replace a published version with different package bytes; bump info.json version')
    entry = {
        'version': info['version'], 'desc': description, 'sha256': digest,
        'url': release_url(info), 'minBobVersion': info['minBobVersion'], 'timestamp': timestamp
    }
    prepared = {'identifier': info['identifier'], 'versions': [entry] + [
        old for old in feed['versions'] if old['version'] != info['version']
    ]}
    validate_feed(prepared, info)
    destination = artifact.parent / 'appcast.json'
    if destination.resolve() == (root / 'appcast.json').resolve():
        raise ValueError('Candidate appcast must be generated outside the source directory')
    write_json(destination, prepared)
    verify_package(root, artifact, destination)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'build', 'prepare', 'verify', 'finalize'])
    parser.add_argument('--root', type=Path, default=PROJECT_ROOT)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--artifact', type=Path)
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--appcast', type=Path)
    parser.add_argument('--github', action='store_true', help='Verify the uploaded public GitHub asset as well')
    args = parser.parse_args(argv)
    if args.github and args.command not in ('prepare', 'verify', 'finalize'):
        parser.error('--github is only supported for prepare, verify, or finalize')
    root = args.root.resolve()
    info = check_source(root)
    output_dir = args.output_dir or root / 'dist'
    artifact = args.artifact or output_dir / release_filename(info)
    notes_file = args.notes_file or root / 'release-notes.txt'

    if args.command == 'check':
        print('Source metadata valid: ' + info['version'])
    elif args.command == 'build':
        print('Built ' + str(build_package(root, output_dir)))
    elif args.command == 'verify':
        verify_package(root, artifact, args.appcast)
        published_timestamp = verify_github(info, artifact) if args.github else None
        if published_timestamp is not None and args.appcast:
            if read_json(args.appcast)['versions'][0]['timestamp'] != published_timestamp:
                raise ValueError('appcast timestamp differs from GitHub publication time')
        print('Verified %s (SHA-256 %s)' % (artifact, artifact_hash(artifact)))
    else:
        if not artifact.exists():
            if args.artifact is not None:
                raise ValueError('Explicit artifact does not exist: ' + str(artifact))
            artifact = build_package(root, output_dir)
        verify_package(root, artifact)
        timestamp = (verify_github(info, artifact) if args.command == 'finalize' or args.github
                     else int(datetime.now(timezone.utc).timestamp() * 1000))
        candidate = prepare_appcast(root, artifact, notes_file, timestamp)
        if args.command == 'finalize':
            atomic_write(root / 'appcast.json', candidate.read_bytes())
            print('Finalized appcast.json after verifying the published GitHub asset')
        else:
            print('Prepared ' + str(candidate))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print('Error: ' + str(error), file=sys.stderr)
        sys.exit(1)
