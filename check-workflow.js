import dotenv from 'dotenv';
dotenv.config();

const owner = process.env.GITHUB_REPO_OWNER || 'ASH-13xen';
const repo = process.env.GITHUB_REPO_NAME || 'dh-separator';
const token = process.env.GITHUB_PAT;

if (!token) {
  console.error('No GITHUB_PAT found in .env');
  process.exit(1);
}

async function checkRuns() {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Antigravity-Agent'
      }
    });
    if (!res.ok) {
      console.error('Failed to fetch runs:', res.status, await res.text());
      return;
    }
    const data = await res.json();
    console.log('Recent Workflow Runs:');
    data.workflow_runs.forEach(run => {
      console.log(`- Run #${run.run_number} (${run.name}):`);
      console.log(`  ID: ${run.id}`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Conclusion: ${run.conclusion}`);
      console.log(`  Created At: ${run.created_at}`);
      console.log(`  URL: ${run.html_url}`);
    });
  } catch (err) {
    console.error(err);
  }
}

checkRuns();
