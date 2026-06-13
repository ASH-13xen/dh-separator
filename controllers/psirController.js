import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { PsirBook } from '../models/PsirBook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// RFC 4180 compliant CSV Parser
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

function sanitizeForPdf(str) {
  if (!str) return "";
  return str
      .replace(/[\u201c\u201d]/g, '"') // smart double quotes
      .replace(/[\u2018\u2019]/g, "'") // smart single quotes
      .replace(/[\u2014\u2013]/g, '-') // dashes
      .replace(/\u00a0/g, ' ')         // non-breaking space
      .replace(/\u2026/g, '...')       // ellipsis
      .replace(/[^\x00-\xff]/g, '');   // strip anything else outside ISO-8859-1
}

async function fetchUrlsInParallel(urls, concurrencyLimit = 5) {
  const results = {};
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  
  for (let i = 0; i < uniqueUrls.length; i += concurrencyLimit) {
    const chunk = uniqueUrls.slice(i, i + concurrencyLimit);
    const promises = chunk.map(async (url) => {
      const cleanUrl = url.replace('https//', 'https://').replace('http//', 'http://');
      try {
        const res = await fetch(cleanUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const buffer = await res.arrayBuffer();
        results[url] = buffer;
      } catch (err) {
        console.error(`Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

export const previewPsirData = async (req, res) => {
  try {
    const csvPath = path.join(process.cwd(), 'psir_questions_updated (2).csv');
    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ error: 'PSIR questions CSV file not found.' });
    }
    
    const csvData = fs.readFileSync(csvPath, 'utf8');
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1); // skip headers
    
    const hierarchy = {};
    
    rows.forEach(r => {
      if (r.length < 10) return;
      const section = r[0].trim();
      const topic = r[1].trim();
      const questionText = r[2].trim();
      const topperName = r[3].trim();
      const topperYear = r[4].trim();
      const topperRank = r[5].trim();
      const topperMarks = r[6].trim();
      const url = r[7].trim();
      const paper = r[9].trim();
      
      if (!questionText || !paper) return;
      
      if (!hierarchy[paper]) {
        hierarchy[paper] = {
          paper: paper,
          section: section,
          topics: {}
        };
      }
      
      const paperObj = hierarchy[paper];
      if (!paperObj.topics[topic]) {
        paperObj.topics[topic] = {
          title: topic,
          questions: {}
        };
      }
      
      const topicObj = paperObj.topics[topic];
      const qKey = `${paper}||${section}||${topic}||${questionText}`;
      if (!topicObj.questions[qKey]) {
        topicObj.questions[qKey] = {
          _id: Buffer.from(qKey).toString('base64'),
          question_text: questionText,
          file_urls: []
        };
      }
      
      if (url) {
        topicObj.questions[qKey].file_urls.push({
          url: url,
          topper_name: topperName || 'Unknown Topper',
          topper_year: topperYear || '',
          topper_rank: topperRank || '',
          topper_marks: topperMarks || ''
        });
      }
    });
    
    const result = Object.values(hierarchy).map(paperObj => {
      const topicsArray = Object.values(paperObj.topics).map(topObj => {
        const questionsArray = Object.values(topObj.questions);
        return {
          title: topObj.title,
          questions: questionsArray
        };
      });
      
      topicsArray.sort((a, b) => a.title.localeCompare(b.title));
      
      return {
        paper: paperObj.paper,
        section: paperObj.section,
        topics: topicsArray
      };
    });
    
    const paperOrder = { 'Paper 1A': 1, 'Paper 1B': 2, 'Paper 2A': 3, 'Paper 2B': 4 };
    result.sort((a, b) => {
      const orderA = paperOrder[a.paper] || 99;
      const orderB = paperOrder[b.paper] || 99;
      return orderA - orderB;
    });
    
    res.json(result);
  } catch (err) {
    console.error('[PsirController] Preview error:', err);
    res.status(500).json({ error: 'Failed to parse and group PSIR questions.', details: err.message });
  }
};

export const generatePsirPdf = async (req, res) => {
  try {
    const { paper, selections, includedQuestionIds } = req.body;

    if (!paper) {
      return res.status(400).json({ error: 'Paper name is required to generate PDF.' });
    }

    if (!includedQuestionIds || !Array.isArray(includedQuestionIds) || includedQuestionIds.length === 0) {
      return res.status(400).json({ error: 'Please select at least one question to include in the book.' });
    }

    // 1. Create a new PsirBook job record in database
    const job = await PsirBook.create({
      paper,
      status: 'pending'
    });

    console.log(`[PsirController] Created compilation job record in DB. ID: ${job._id}`);

    // 2. Dispatch GitHub Action Workflow Run
    const { GITHUB_PAT, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_WORKFLOW_NAME, GITHUB_REF } = process.env;

    if (!GITHUB_PAT || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GITHUB_WORKFLOW_NAME) {
      const errorMsg = 'GitHub Actions environment variables are missing from server configuration.';
      console.error(`[PsirController] ${errorMsg}`);
      job.status = 'failed';
      job.error = errorMsg;
      await job.save();
      return res.status(500).json({ error: errorMsg });
    }

    const githubUrl = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/${GITHUB_WORKFLOW_NAME}/dispatches`;

    console.log(`[PsirController] Dispatching GitHub Workflow at URL: ${githubUrl}`);

    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_PAT}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DH-Separator-Backend'
      },
      body: JSON.stringify({
        ref: GITHUB_REF || 'main',
        inputs: {
          paper: paper,
          selections: JSON.stringify(selections || {}),
          includedQuestionIds: JSON.stringify(includedQuestionIds),
          jobId: job._id.toString()
        }
      })
    });

    if (response.status !== 204) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch (e) {
        responseBody = 'Failed to read response body.';
      }
      const errorDetails = `GitHub API returned status code ${response.status}: ${responseBody}`;
      console.error(`[PsirController] GitHub Action dispatch failed. ${errorDetails}`);
      job.status = 'failed';
      job.error = errorDetails;
      await job.save();
      return res.status(500).json({ error: 'Failed to trigger compilation runner.', details: errorDetails });
    }

    console.log(`[PsirController] GitHub Actions workflow dispatched successfully for Job ID: ${job._id}`);

    res.status(202).json({
      message: 'PDF generation has been successfully offloaded and queued in GitHub Actions.',
      jobId: job._id
    });

  } catch (error) {
    console.error(`[PsirController] Error initiating PDF generation:`, error);
    res.status(500).json({ error: 'Failed to initiate PDF book generation.', details: error.message });
  }
};

export const getPsirBookStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await PsirBook.findById(id);
    if (!job) {
      return res.status(404).json({ error: 'Compilation job not found.' });
    }
    res.json(job);
  } catch (err) {
    console.error('[PsirController] Get status error:', err);
    res.status(500).json({ error: 'Failed to retrieve compilation job status.', details: err.message });
  }
};
