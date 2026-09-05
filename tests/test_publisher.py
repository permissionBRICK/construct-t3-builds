import importlib.util
from pathlib import Path
import tempfile
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

    def test_new_version_or_selected_patch_changes_identity(self):
        first = self.choose()['tag']
        self.assertNotEqual(first, self.choose(version='1.0.1')['tag'])
        self.assertNotEqual(first, self.choose(hashes={**self.hashes, 'release': 'changed'})['tag'])
        self.assertEqual(first, self.choose(hashes={**self.hashes, 'nightly': 'changed'})['tag'])

    def test_whole_nightly_inventory_can_target_stable(self):
        tried = []
        def compatible(inventory):
            tried.append(inventory)
            return inventory == 'nightly'
        result = self.choose(compatible=compatible)
        self.assertEqual(['release', 'nightly'], tried)
        self.assertEqual('nightly', result['inventory'])
        self.assertTrue(result['tag'].startswith('t3-1.0.0-'))

    def test_failed_inventories_do_not_publish_anything(self):
        result = self.choose(compatible=lambda _: False)
        self.assertFalse(result['build'])
        self.assertNotIn('tag', result)

    def test_draft_incomplete_and_prerelease_are_never_reused(self):
        release = dict(draft=False, prerelease=False, assets=[dict(name=n) for n in p.ASSETS])
        self.assertTrue(p.complete_release(release))
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

if __name__ == '__main__':
    unittest.main()
