import { readFile } from 'node:fs/promises';
const forbidden = new RegExp('\\b(?:FI' + 'T|AT' + 'S)\\d+|mon' + 'ash', 'iu');
for (const file of ['dist/moodle.js', 'dist/worker/worker.js', 'dist/worker/recovery.js', 'skills/moodle-cli/SKILL.md', 'README.md', 'skills/moodle-cli/references/commands.md', 'skills/moodle-cli/references/usage.md', 'skills/moodle-cli/references/setup-and-auth.md']) {
  if (forbidden.test(await readFile(file, 'utf8'))) throw new Error(`Institution literal in shipped artifact: ${file}`);
}
console.log('Shipped artifacts use institution-neutral vocabulary.');
