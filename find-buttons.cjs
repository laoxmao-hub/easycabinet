const fs = require('fs');
const path = require('path');

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walk(full));
    } else if (entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

const files = walk('src');
const hits = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('<button') || line.includes('title=')) continue;
    
    // Collect next 10 lines to see button content
    let snippet = '';
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      snippet += lines[j].trim() + '\n';
    }
    
    // Check if it's a self-closing or closed within 10 lines
    if (!snippet.includes('</button>')) continue;
    
    // Check if button has visible text (span, p, div, h1-6, label, a)
    if (/<span[\s>]|<p[\s>]|<p className|<div[\s>]|<h[1-6]|<label[\s>]|<a[\s>]/i.test(snippet)) continue;
    
    // It's icon-only! Extract what the button does
    const onClickMatch = snippet.match(/onClick[^}]*}/);
    const title = onClickMatch ? onClickMatch[0].substring(0, 80) : 'unknown';
    
    hits.push({
      file: file.replace(/\\/g, '/'),
      line: i + 1,
      context: snippet.substring(0, 200).replace(/\n/g, ' ').trim()
    });
  }
}

console.log(`Found ${hits.length} icon-only buttons without title:\n`);
for (const h of hits) {
  console.log(`${h.file}:${h.line}`);
  console.log(`  ${h.context.substring(0, 150)}\n`);
}
