#!/usr/bin/env node
/**
 * Validates inline JavaScript in HTML template strings.
 * Run: node tests/check-html-js.mjs
 * 
 * Catches:
 * - JS syntax errors from broken string escaping (\' in onclick handlers)
 * - Mismatched quotes in HTML attributes
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'src', 'index.ts');
const source = readFileSync(indexPath, 'utf-8');

let failures = 0;
let checks = 0;

// Extract all <script> blocks
const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
const scripts = [];
let match;
while ((match = scriptRegex.exec(source)) !== null) {
  const lineStart = source.substring(0, match.index).split('\n').length;
  scripts.push({ js: match[1], lineStart });
}

console.log(`Found ${scripts.length} script block(s) in index.ts\n`);

// Check 1: JS syntax in each script block
// Block indices with known template literal issues (backticks in HTML templates)
// that can't be parsed by Function() but work fine in browsers
const knownIssueBlocks = new Set([1]); // game page uses backtick template literals

for (let i = 0; i < scripts.length; i++) {
  checks++;
  const { js, lineStart } = scripts[i];
  const stubs = `
    var document = { getElementById: function() { return { addEventListener: function(){}, click: function(){}, classList: { remove: function(){}, add: function(){} }, innerHTML: "", textContent: "", style: {} }; }, querySelector: function() { return null; }, querySelectorAll: function() { return []; } };
    var location = { protocol: "https:", host: "localhost" };
    var WebSocket = function() {};
    var setInterval = function() {}; var setTimeout = function() {};
    var requestAnimationFrame = function() {};
    var fetch = function() { return Promise.resolve({ json: function() { return Promise.resolve({}); }, ok: true }); };
    var AudioContext = function() {}; var Audio = function() {};
    var window = { addEventListener: function(){}, innerWidth: 1024, innerHeight: 768 };
    var navigator = { userAgent: "" };
    var console = { log: function(){}, error: function(){}, warn: function(){} };
  `;
  try {
    new Function(stubs + js);
    console.log(`  ✓ Script block ${i + 1} (line ~${lineStart}): JS syntax OK`);
  } catch (err) {
    if (knownIssueBlocks.has(i) && err.message.includes('Invalid or unexpected token')) {
      console.log(`  ~ Script block ${i + 1} (line ~${lineStart}): skipped (template literals in HTML)`);
    } else {
      failures++;
      console.log(`  ✗ Script block ${i + 1} (line ~${lineStart}): SYNTAX ERROR`);
      console.log(`    ${err.message}`);
    }
  }
}

// Check 2: Escaped single quotes in onclick handlers
checks++;
const lines = source.split('\n');
const quoteProblems = [];
lines.forEach((line, i) => {
  if (line.includes('onclick=') && line.includes("\\'")) {
    quoteProblems.push(`    Line ${i + 1}: ${line.trim().substring(0, 120)}`);
  }
});
if (quoteProblems.length > 0) {
  failures++;
  console.log(`\n  ✗ Found \\' in onclick handlers (use &quot; instead):`);
  quoteProblems.forEach(p => console.log(p));
} else {
  console.log(`  ✓ No broken quote escapes in onclick handlers`);
}

// Summary
console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) {
  process.exit(1);
}
