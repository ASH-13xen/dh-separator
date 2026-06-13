import dotenv from 'dotenv';
dotenv.config();

const owner = process.env.GITHUB_REPO_OWNER || 'ASH-13xen';
const repo = process.env.GITHUB_REPO_NAME || 'dh-separator';
const token = process.env.GITHUB_PAT;

if (!token) {
  console.error('No GITHUB_PAT found in .env');
  process.exit(1);
}

const runId = '27480417619';

async function checkJobs() {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Antigravity-Agent'
      }
    });
    if (!res.ok) {
      console.error('Failed to fetch jobs:', res.status, await res.text());
      return;
    }
    const data = await res.json();
    console.log('Jobs in Run:');
    data.jobs.forEach(job => {
      console.log(`- Job ${job.name} (ID: ${job.id}):`);
      console.log(`  Status: ${job.status}`);
      console.log(`  Conclusion: ${job.conclusion}`);
      console.log(`  Steps:`);
      job.steps.forEach(step => {
        console.log(`    * Step ${step.name}: status=${step.status}, conclusion=${step.conclusion}`);
      });
    });
  } catch (err) {
    console.error(err);
  }
}

checkJobs();
