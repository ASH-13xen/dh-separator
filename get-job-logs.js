import dotenv from 'dotenv';
dotenv.config();

const owner = process.env.GITHUB_REPO_OWNER || 'ASH-13xen';
const repo = process.env.GITHUB_REPO_NAME || 'dh-separator';
const token = process.env.GITHUB_PAT;

if (!token) {
  console.error('No GITHUB_PAT found in .env');
  process.exit(1);
}

const jobId = '81227089289';

async function checkLogs() {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Antigravity-Agent'
      }
    });
    if (!res.ok) {
      console.error('Failed to fetch logs:', res.status, await res.text());
      return;
    }
    const logText = await res.text();
    console.log('--- START OF JOB LOGS ---');
    console.log(logText);
    console.log('--- END OF JOB LOGS ---');
  } catch (err) {
    console.error(err);
  }
}

checkLogs();
