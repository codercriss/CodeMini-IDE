'use strict';
// Where things are, in one place, so that no test has to guess.
//
//   ROOT         the app folder: the one with index.html and package.json.
//   runnerDir()  the runner. In the GitHub repository it is runner/ INSIDE the app folder; in the hand-over zip it sits BESIDE the app folder
//                (../runner). Both are found, so the tests run unchanged from either (no scratch copy needed). If it is in neither, the error
//                says where it looked and where it has to be.
//   read(rel)    a file as UTF-8 text. "runner/..." is looked up in the runner folder, anything else relative to ROOT. A missing file whose
//                name starts with a dot gets a plain explanation: the iOS Files app hides those, so they are the ones that go missing when a
//                repository is uploaded from a phone (this kept CI red on 2026-10-28 with only "ENOENT" to go on).
//   exists(rel)  the same lookup, true or false.
//   resolve(rel) the absolute path.
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_CANDIDATES = [path.join(ROOT, 'runner'), path.resolve(ROOT, '..', 'runner')];

function runnerDir() {
  const found = RUNNER_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'exec.js')));
  if (!found) {
    throw new Error('The runner folder was not found. Looked in ' + RUNNER_CANDIDATES.join(' and ') +
      '. It must be runner/ inside the app folder (as in the GitHub repository) or next to the app folder (as in the hand-over zip), ' +
      'and hold exec.js, exec.html, shell.js, config.js and vercel.json.');
  }
  return found;
}

function resolve(rel) {
  const m = /^runner[\/\\](.*)$/.exec(rel);
  return m ? path.join(runnerDir(), m[1]) : path.join(ROOT, rel);
}

function exists(rel) {
  try { return fs.existsSync(resolve(rel)); } catch (e) { return false; }
}

function read(rel) {
  try { return fs.readFileSync(resolve(rel), 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT' && /(^|\/)\./.test(rel)) {
      e.message = rel + ' is missing from the repository. Files and folders that start with a dot are hidden in the iOS Files app, so they are ' +
        'easy to leave out when uploading: create it in the GitHub web editor (Add file > Create new file, type the name with its folder). ' + e.message;
    }
    throw e;
  }
}

module.exports = { ROOT, runnerDir, resolve, exists, read };
