"""Exercise NSIS include handling with a representative pnpm package path."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class NsisPaths(unittest.TestCase):
    def test_short_build_root_keeps_nested_includes_compilable(self):
        candidates = list((Path.home() / '.cache/electron-builder/nsis-3.0.4.1').glob('*/linux/makensis'))
        if not candidates:
            self.skipTest('NSIS tool cache is populated by Windows packaging')
        compiler = candidates[0]
        # Same short cache root as scripts/build.sh, a hash-only source key, and
        # the nested dependency location NSIS sees when electron-builder runs.
        with tempfile.TemporaryDirectory(prefix='t3-src.', dir='/tmp') as root:
            include = Path(root) / ('a' * 20) / 'node_modules/.pnpm/app-builder-lib@26.15.3_dmg-builder@26.15.3_electron-builder-squirrel-windows@26.15.3/node_modules/app-builder-lib/templates/nsis/include/fixture.nsh'
            include.parent.mkdir(parents=True)
            include.write_text('; fixture\n')
            script = f'!include "{include}"\nOutFile "{root}/test.exe"\nSection\nSectionEnd\n'
            result = subprocess.run([str(compiler), '-V2', '-'], input=script, text=True,
                                    capture_output=True, env={**os.environ, 'NSISDIR': str(compiler.parent.parent)})
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertTrue((Path(root) / 'test.exe').is_file())

if __name__ == '__main__':
    unittest.main()
