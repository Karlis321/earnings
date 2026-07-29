#!/usr/bin/env node
/**
 * Strip HTML tags/entities from a fetched document to plain text. Used
 * by /earnings when a raw press release is too large for the Read
 * tool's 256KB limit — we extract to text (usually ~1/3 the size),
 * write it beside the source, and Read the .txt instead.
 *
 *   node scripts/extract-doc-text.mjs <html-file>
 *     Writes <file>.txt next to the input. Prints the output path +
 *     char count to stdout.
 *
 *   node scripts/extract-doc-text.mjs <html-file> --grep "pattern"
 *     Prints matching lines with 2 lines of leading and trailing
 *     context. Case-insensitive regex. Nothing written to disk.
 *     Use this for targeted pulls ("cash cost", "guidance",
 *     "by-product credits") when the whole doc would still be large
 *     after text-ification.
 *
 * Exit codes: 0 on success, 1 on I/O error, 2 on usage error.
 */

import fs from "node:fs";
import path from "node:path";

function usage(msg) {
  if (msg) process.stderr.write(`extract-doc-text: ${msg}\n`);
  process.stderr.write(`usage: node scripts/extract-doc-text.mjs <html-file> [--grep "pattern"]\n`);
  process.exit(2);
}

// Minimal HTML → text. Not a browser-grade parser — good enough for
// press-release markup. Preserves paragraph breaks so subsequent grep
// context has meaningful line boundaries.
function htmlToText(html) {
  let t = html;
  // Drop scripts, styles, and comments — they carry no press-release content.
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  // Convert block-level closers into newlines so paragraphs and table
  // rows land on their own line.
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|thead|tbody|tfoot)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  // Table cells → tab so numeric columns stay adjacent.
  t = t.replace(/<\/t[dh]>/gi, "\t");
  // Strip remaining tags.
  t = t.replace(/<[^>]+>/g, "");
  // Decode a small set of common entities. Full entity table not needed
  // for press releases — most content is plain ASCII plus curly quotes,
  // dashes, non-breaking spaces.
  const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
    "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”",
    "&reg;": "®", "&trade;": "™", "&copy;": "©", "&deg;": "°", "&times;": "×",
  };
  t = t.replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  t = t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  // Collapse whitespace within lines, drop blank runs, strip line-edge whitespace.
  t = t
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return t;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage("missing <html-file>");
  const input = args[0];
  let pattern = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--grep") {
      pattern = args[i + 1];
      i++;
      if (!pattern) usage("--grep needs a pattern");
    }
  }

  let html;
  try { html = fs.readFileSync(input, "utf-8"); }
  catch (e) { process.stderr.write(`extract-doc-text: cannot read ${input} — ${e.message}\n`); process.exit(1); }

  const text = htmlToText(html);

  if (pattern) {
    let re;
    try { re = new RegExp(pattern, "i"); }
    catch (e) { usage(`invalid regex: ${e.message}`); }
    const lines = text.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(i);
    }
    if (hits.length === 0) {
      process.stdout.write(`(no lines match /${pattern}/i in ${input})\n`);
      return;
    }
    const shown = new Set();
    const chunks = [];
    for (const h of hits) {
      const lo = Math.max(0, h - 2);
      const hi = Math.min(lines.length - 1, h + 2);
      const block = [];
      for (let i = lo; i <= hi; i++) {
        if (shown.has(i)) continue;
        shown.add(i);
        block.push(`${String(i + 1).padStart(5, " ")} ${i === h ? ">" : ":"} ${lines[i]}`);
      }
      if (block.length) chunks.push(block.join("\n"));
    }
    process.stdout.write(chunks.join("\n---\n") + "\n");
    process.stdout.write(`\n(${hits.length} matches in ${input})\n`);
    return;
  }

  const outfile = input.replace(/\.(html?|htm)$/i, "") + ".txt";
  const finalOut = outfile === input ? input + ".txt" : outfile;
  fs.writeFileSync(finalOut, text);
  const rel = path.relative(process.cwd(), finalOut).split(path.sep).join("/");
  process.stdout.write(`${rel} · ${text.length} chars · ${text.split("\n").length} lines\n`);
}

try { main(); }
catch (e) { process.stderr.write(`extract-doc-text: unhandled — ${e.stack ?? e.message ?? e}\n`); process.exit(1); }
