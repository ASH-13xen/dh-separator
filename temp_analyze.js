import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), 'psir_questions_updated.csv');
const data = fs.readFileSync(file, 'utf8');

function parseCSV(text) {
  const lines = [];
  let i = 0;
  const len = text.length;
  
  while (i < len) {
    const row = [];
    while (i < len) {
      let field = "";
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
      }
      row.push(field);
      
      if (i < len && text[i] === ',') {
        i++; // skip comma
      } else {
        // End of row
        if (i < len && text[i] === '\r') {
          i++;
          if (i < len && text[i] === '\n') {
            i++;
          }
        } else if (i < len && text[i] === '\n') {
          i++;
        }
        break;
      }
    }
    lines.push(row);
  }
  return lines;
}

const parsed = parseCSV(data);
const headers = parsed[0];
console.log('Headers:', headers);
const rows = parsed.slice(1);

const papers = new Set();
const sections = new Set();
const topics = new Set();
const paperToSections = {};

rows.forEach((r, idx) => {
  if (r.length < 10) {
    if (r.length > 1 || r[0] !== '') {
      console.log(`Skipping invalid row ${idx + 2}: length = ${r.length}`, r);
    }
    return;
  }
  const sec = r[0].trim();
  const top = r[1].trim();
  const paper = r[9].trim();
  
  if (paper) papers.add(paper);
  if (sec) sections.add(sec);
  if (top) topics.add(top);
  
  if (paper && sec) {
    if (!paperToSections[paper]) paperToSections[paper] = new Set();
    paperToSections[paper].add(sec);
  }
});

console.log('Unique Papers:', Array.from(papers));
console.log('Unique Sections count:', sections.size);
console.log('Unique Topics count:', topics.size);
console.log('Paper to Sections mapping:');
for (const paper of Object.keys(paperToSections)) {
  console.log(' -', paper, '->', Array.from(paperToSections[paper]));
}
