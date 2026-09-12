import importlib.util
from pathlib import Path
import tempfile
import json
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).resolve().parents[1] / 'scripts/publisher.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Decisions(unittest.TestCase):
    hashes = {'release': 'stable-patch', 'nightly': 'nightly-patch'}

    def choose(self, version='1.0.0', hashes=None, existing=lambda _: False, compatible=lambda _: True):
        return p.choose(version, hashes or self.hashes, 'recipe', existing, compatible)

    def test_first_build_and_identical_reuse_skip_patch_and_build_work(self):
        first = self.choose()
        second = self.choose(existing=lambda tag: tag == first['tag'],
                             compatible=lambda _: self.fail('cached release must skip source checkout'))
        self.assertTrue(first['build'])
        self.assertFalse(second['build'])
        self.assertEqual(first['tag'], second['tag'])

    def test_verification_builds_even_a_published_pair_and_never_publishes(self):
        first = self.choose()
        published = lambda tag: tag == first['tag']
        self.assertFalse(self.choose(existing=published)['build'])
        verified = self.choose(existing=p.reuse_policy(True, published))
        self.assertTrue(verified['build'])
        self.assertEqual(verified['tag'], first['tag'])
        self.assertFalse(p.reuse_policy(False, published)('other'))
        with tempfile.TemporaryDirectory() as work:
            (Path(work) / 'plan.json').write_text(json.dumps(dict(build=True, verify=True)))
            with self.assertRaises(ValueError):
                p.publish(Path(work))

    def test_new_version_or_selected_patch_changes_identity(self):
        first = self.choose()['tag']
        self.assertNotEqual(first, self.choose(version='1.0.1')['tag'])
        self.assertNotEqual(first, self.choose(hashes={**self.hashes, 'release': 'changed'})['tag'])
        self.assertEqual(first, self.choose(hashes={**self.hashes, 'nightly': 'changed'})['tag'])

    def test_channels_use_only_their_own_inventory(self):
        tried = []
        result = self.choose(compatible=lambda inventory: tried.append(inventory) or False)
        self.assertEqual(['release'], tried)
        self.assertFalse(result['build'])
        tried.clear()
        nightly = p.choose('1.0.1-nightly.20260906.1', self.hashes, 'recipe', lambda _: False,
                           lambda inventory: tried.append(inventory) or True, 'nightly')
        self.assertEqual(['nightly'], tried)
        self.assertTrue(nightly['build'])
        self.assertNotEqual(p.identity('1.0.0', 'patch', 'recipe'),
                            p.identity('1.0.0', 'patch', 'recipe', 'nightly'))

    def test_failed_inventories_do_not_publish_anything(self):
        result = self.choose(compatible=lambda _: False)
        self.assertFalse(result['build'])
        self.assertNotIn('tag', result)

    def test_draft_incomplete_and_prerelease_are_never_reused(self):
        release = dict(draft=False, prerelease=False, assets=[dict(name=n) for n in p.ASSETS])
        self.assertTrue(p.complete_release(release))
        self.assertTrue(p.complete_release({**release, 'prerelease': True}, 'nightly'))
        self.assertFalse(p.complete_release(release, 'nightly'))
        for change in [dict(draft=True), dict(prerelease=True), dict(assets=[]), dict(assets=release['assets'][:-1])]:
            self.assertFalse(p.complete_release({**release, **change}))

    def test_only_artifact_producing_files_invalidate_recipe(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'scripts').mkdir()
            for file in ['config.json', 'scripts/build.sh', 'scripts/package-linux.mjs']:
                (root / file).write_text('original')
            before = p.recipe_hash(root)
            (root / 'README.md').write_text('unrelated Construct or publisher commit')
            (root / 'scripts/publisher.py').write_text('polling change')
            self.assertEqual(before, p.recipe_hash(root))
            (root / 'scripts/package-linux.mjs').write_text('changed native packaging')
            self.assertNotEqual(before, p.recipe_hash(root))

class Publication(unittest.TestCase):
    def test_failed_upload_or_verification_never_promotes_draft(self):
        for failure in ('upload', 'verification'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                out = work / 'artifacts'
                out.mkdir()
                plan = dict(build=True, repository='owner/builds', tag='test-tag', buildHash='a' * 64,
                            publisherCommit='b' * 40, buildRepositoryCommit='c' * 40, upstreamCommit='d' * 40,
                            inventory='release', channel='stable', version='1.0.0', nodeVersion='26.8.1')
                (work / 'plan.json').write_text(json.dumps(plan))
                for name in p.ASSETS[:2]:
                    (out / name).write_bytes(b'validated build')
                (out / 'manifest.json').write_text(json.dumps(dict(buildHash=plan['buildHash'],
                    assets={name: dict(sha256=p.digest(out / name)) for name in p.ASSETS[:2]})))
                (out / 'SHA256SUMS').write_text('checksums')
                calls = []
                def command(*args, **kwargs):
                    calls.append(args)
                    if args[2] == 'upload' and failure == 'upload':
                        raise RuntimeError('upload failed')
                    if args[2] == 'download':
                        for name in p.ASSETS:
                            (work / 'uploaded' / name).write_bytes(b'corrupted uploaded bytes')
                    return ''
                with patch.object(p, 'api', return_value=None), patch.object(p, 'run', side_effect=command):
                    with self.assertRaises((RuntimeError, ValueError)):
                        p.publish(work)
                self.assertTrue(any(c[2] == 'create' and '--draft' in c for c in calls))
                self.assertFalse(any(c[2] == 'edit' for c in calls), 'Failed draft must never become latest')


if __name__ == '__main__':
    unittest.main()
