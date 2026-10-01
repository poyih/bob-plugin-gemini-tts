import contextlib
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile


SOURCE_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', SOURCE_ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gemini-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in release.RUNTIME_FILES + ('appcast.json', 'release-notes.txt'):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE_ROOT / name, destination)
        info = release.read_json(self.root / 'info.json')
        feed = release.read_json(self.root / 'appcast.json')
        if feed['versions'] and release.version_tuple(info['version']) <= release.version_tuple(feed['versions'][0]['version']):
            major, minor, patch = release.version_tuple(feed['versions'][0]['version'])
            info['version'] = '%s.%s.%s' % (major, minor, patch + 1)
            release.write_json(self.root / 'info.json', info)
        self.info = info
        self.output = self.root / 'dist'
        self.notes = self.root / 'release-notes.txt'
        self.timestamp = int(datetime(2026, 10, 2, tzinfo=timezone.utc).timestamp() * 1000)

    def build(self):
        return release.build_package(self.root, self.output)

    def remote_release(self, artifact):
        return {
            'tag_name': 'v' + self.info['version'], 'draft': False, 'prerelease': False,
            'published_at': '2026-10-02T00:00:00Z',
            'assets': [{
                'name': artifact.name, 'browser_download_url': release.release_url(self.info),
                'size': artifact.stat().st_size, 'digest': 'sha256:' + release.artifact_hash(artifact)
            }]
        }

    def mock_downloads(self, artifact, metadata, remote=None):
        remote = artifact.read_bytes() if remote is None else remote

        def read_url(url, limit, api=False):
            if api:
                self.assertEqual(url, 'https://api.github.com/repos/poyih/bob-plugin-gemini-tts/releases/tags/v' + self.info['version'])
                return json.dumps(metadata).encode('utf-8')
            self.assertEqual(url, release.release_url(self.info))
            return remote

        return mock.patch.object(release, 'read_url', side_effect=read_url)

    def test_build_contains_all_runtime_modules_and_is_reproducible_despite_source_mtime(self):
        first = self.build()
        expected = first.read_bytes()
        for name in release.RUNTIME_FILES:
            os.utime(self.root / name, (1_800_000_000, 1_800_000_000))
        second = release.build_package(self.root, self.root / 'second')
        self.assertEqual(second.read_bytes(), expected)
        with zipfile.ZipFile(first) as package:
            self.assertEqual(package.namelist(), list(release.RUNTIME_FILES))
            for name in release.RUNTIME_FILES:
                self.assertEqual(package.read(name), (self.root / name).read_bytes())
        checksum = first.with_suffix('.bobplugin.sha256').read_text()
        self.assertEqual(checksum, '%s  %s\n' % (release.artifact_hash(first), first.name))

    def test_candidate_feed_uses_package_metadata_and_preserves_published_history(self):
        before = (self.root / 'appcast.json').read_bytes()
        artifact = self.build()
        candidate = release.prepare_appcast(self.root, artifact, self.notes, self.timestamp)
        feed = release.read_json(candidate)
        self.assertEqual((self.root / 'appcast.json').read_bytes(), before)
        self.assertEqual(feed['versions'][1:], json.loads(before)['versions'])
        entry = feed['versions'][0]
        self.assertEqual(entry['version'], self.info['version'])
        self.assertEqual(entry['sha256'], release.artifact_hash(artifact))
        self.assertEqual(entry['url'], release.release_url(self.info))
        self.assertEqual(entry['minBobVersion'], self.info['minBobVersion'])
        self.assertEqual(entry['timestamp'], self.timestamp)
        release.verify_package(self.root, artifact, candidate)

    def test_missing_runtime_dependency_is_detected_before_building(self):
        with (self.root / 'main.js').open('a') as output:
            output.write("\nrequire('./lib/missing.js');\n")
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.build()

    def test_package_verification_rejects_missing_extra_duplicate_or_modified_modules(self):
        artifact = self.build()
        with zipfile.ZipFile(artifact) as package:
            entries = [(name, package.read(name)) for name in package.namelist()]
        cases = [
            entries[:-1], entries + [('unwanted.txt', b'extra')], entries + [entries[0]],
            [(name, data + b'\nchanged' if name == 'lib/request.js' else data) for name, data in entries]
        ]
        for values in cases:
            with self.subTest(entries=[name for name, _ in values]):
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    with zipfile.ZipFile(artifact, 'w') as package:
                        for name, data in values:
                            package.writestr(name, data)
                with self.assertRaises(ValueError):
                    release.verify_package(self.root, artifact)

    def test_feed_checksum_version_and_minimum_bob_version_must_match_the_artifact(self):
        artifact = self.build()
        candidate = release.prepare_appcast(self.root, artifact, self.notes, self.timestamp)
        original = release.read_json(candidate)
        for field, value in [('sha256', '0' * 64), ('minBobVersion', '1.0.0'), ('url', 'https://example.com/wrong')]:
            malformed = json.loads(json.dumps(original))
            malformed['versions'][0][field] = value
            release.write_json(candidate, malformed)
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.verify_package(self.root, artifact, candidate)
        release.write_json(candidate, release.read_json(self.root / 'appcast.json'))
        with self.assertRaisesRegex(ValueError, 'package version'):
            release.verify_package(self.root, artifact, candidate)

    def test_package_verification_rejects_symlink_runtime_entries(self):
        artifact = self.build()
        with zipfile.ZipFile(artifact, 'w') as package:
            for name in release.RUNTIME_FILES:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (0o120777 if name == 'main.js' else 0o100644) << 16
                package.writestr(entry, (self.root / name).read_bytes())
        with self.assertRaisesRegex(ValueError, 'non-regular'):
            release.verify_package(self.root, artifact)

    def test_published_versions_cannot_be_replaced_with_different_bytes(self):
        artifact = self.build()
        candidate = release.prepare_appcast(self.root, artifact, self.notes, self.timestamp)
        release.atomic_write(self.root / 'appcast.json', candidate.read_bytes())
        before = (self.root / 'appcast.json').read_bytes()
        with (self.root / 'main.js').open('a') as output:
            output.write('\n// Different package bytes.\n')
        artifact = self.build()
        with self.assertRaisesRegex(ValueError, 'published version'):
            release.prepare_appcast(self.root, artifact, self.notes, self.timestamp)
        self.assertEqual((self.root / 'appcast.json').read_bytes(), before)

    def test_candidate_generation_cannot_overwrite_the_source_appcast(self):
        artifact = release.build_package(self.root, self.root)
        before = (self.root / 'appcast.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'outside the source'):
            release.prepare_appcast(self.root, artifact, self.notes, self.timestamp)
        self.assertEqual((self.root / 'appcast.json').read_bytes(), before)

    def test_finalize_verifies_uploaded_bytes_and_uses_the_actual_publication_time(self):
        artifact = self.build()
        metadata = self.remote_release(artifact)
        with self.mock_downloads(artifact, metadata), contextlib.redirect_stdout(io.StringIO()):
            release.main(['finalize', '--root', str(self.root)])
        feed = release.read_json(self.root / 'appcast.json')
        self.assertEqual(feed['versions'][0]['timestamp'], self.timestamp)
        release.verify_package(self.root, artifact, self.root / 'appcast.json')
        self.assertEqual(sum(item['version'] == self.info['version'] for item in feed['versions']), 1)
        # Running it again is safe and does not append a duplicate release.
        with self.mock_downloads(artifact, metadata), contextlib.redirect_stdout(io.StringIO()):
            release.main(['finalize', '--root', str(self.root)])
        self.assertEqual(release.read_json(self.root / 'appcast.json'), feed)

    def test_remote_metadata_or_hash_mismatch_leaves_source_feed_untouched(self):
        artifact = self.build()
        before = (self.root / 'appcast.json').read_bytes()
        original = self.remote_release(artifact)
        cases = []
        for field, value in [('draft', True), ('prerelease', True), ('tag_name', 'v0.0.0'), ('published_at', '2026-10-02T00:00:00')]:
            metadata = json.loads(json.dumps(original))
            metadata[field] = value
            cases.append(metadata)
        for field, value in [('size', 0), ('digest', 'sha256:' + '0' * 64), ('browser_download_url', 'https://example.com/wrong')]:
            metadata = json.loads(json.dumps(original))
            metadata['assets'][0][field] = value
            cases.append(metadata)
        metadata = json.loads(json.dumps(original))
        metadata['assets'] = []
        cases.append(metadata)
        for metadata in cases:
            with self.subTest(metadata=metadata):
                with self.mock_downloads(artifact, metadata), self.assertRaises(ValueError):
                    release.main(['finalize', '--root', str(self.root)])
                self.assertEqual((self.root / 'appcast.json').read_bytes(), before)
        with self.mock_downloads(artifact, original, remote=b'wrong uploaded bytes'), self.assertRaisesRegex(ValueError, 'SHA-256'):
            release.main(['finalize', '--root', str(self.root)])
        self.assertEqual((self.root / 'appcast.json').read_bytes(), before)

    def test_github_token_is_only_used_for_api_calls_not_asset_downloads(self):
        with mock.patch.dict(os.environ, {'GITHUB_TOKEN': 'unit-test-token'}):
            with mock.patch.object(release, 'urlopen') as opener:
                opener.return_value.__enter__.return_value.read.return_value = b'body'
                release.read_url('https://api.github.com/repos/poyih/bob-plugin-gemini-tts', 10, api=True)
                self.assertEqual(opener.call_args.args[0].get_header('Authorization'), 'Bearer unit-test-token')
                release.read_url(release.release_url(self.info), 10)
                self.assertIsNone(opener.call_args.args[0].get_header('Authorization'))

    def test_invalid_version_and_duplicate_feed_versions_are_rejected(self):
        for version in ['../1.0.0', '1.0', '1.0.0;command', '']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                release.version_tuple(version)
        feed = release.read_json(self.root / 'appcast.json')
        feed['versions'].append(feed['versions'][-1])
        with self.assertRaisesRegex(ValueError, 'unique'):
            release.validate_feed(feed, self.info)


if __name__ == '__main__':
    unittest.main()
