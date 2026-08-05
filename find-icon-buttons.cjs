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
    
    // Collect content between <button and </button>
    let depth = 0;
    let btnContent = '';
    for (let j = i; j < Math.min(i + 15, lines.length); j++) {
      btnContent += lines[j] + '\n';
      if (lines[j].includes('</button>')) break;
    }
    
    // Check if self-closing or closed
    if (!btnContent.includes('</button>') && !btnContent.includes('/>')) continue;
    
    // Remove JSX expressions like onClick={() => ...}
    let cleaned = btnContent.replace(/\{[^}]*\}/g, '');
    // Remove className, type, disabled, title attributes
    cleaned = cleaned.replace(/className="[^"]*"/g, '');
    cleaned = cleaned.replace(/className=\{[^}]*\}/g, '');
    cleaned = cleaned.replace(/type="[^"]*"/g, '');
    cleaned = cleaned.replace(/disabled/g, '');
    cleaned = cleaned.replace(/title="[^"]*"/g, '');
    cleaned = cleaned.replace(/<button[^>]*>/g, '');
    cleaned = cleaned.replace(/<\/button>/g, '');
    
    // Check for text content (spaces, quotes, or visible chars that aren't JSX tags or HTML attributes)
    // Remove all JSX tags like <Icon /> or <Icon size={16} />
    let tagsRemoved = cleaned.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');
    tagsRemoved = tagsRemoved.replace(/<[A-Z][a-zA-Z]*[^>]*><\/[A-Z][a-zA-Z]*>/g, '');
    // Remove HTML tags
    tagsRemoved = tagsRemoved.replace(/<[^>]*>/g, '');
    // Remove whitespace
    tagsRemoved = tagsRemoved.replace(/\s/g, '');
    // Remove quotes
    tagsRemoved = tagsRemoved.replace(/"/g, '');
    
    if (tagsRemoved.length > 0) continue; // Has text content
    
    // This is an icon-only button without title
    const onClick = btnContent.match(/onClick[^}]*}/);
    hits.push({
      file: file.replace(/\\/g, '/'),
      line: i + 1,
      snippet: btnContent.substring(0, 200).replace(/\n/g, ' ').trim()
    });
  }
}

console.log(`Found ${hits.length} icon-only buttons without title:\n`);
for (const h of hits) {
  console.log(`${h.file}:${h.line}`);
  console.log(`  ${h.snippet.substring(0, 180)}\n`);
}
