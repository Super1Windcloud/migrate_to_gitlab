import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

const execFileAsync = promisify(execFile);

// Load environment variables
dotenv.config();

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
if (!GITLAB_TOKEN) {
  console.error('❌ Error: GITLAB_TOKEN environment variable is not set in .env');
  process.exit(1);
}

const GITLAB_API_BASE = 'https://gitlab.com/api/v4';
const TARGET_USERNAME = 'Super1Windcloud';
const EXPORT_DIR = process.env.EXPORT_DIR || '/Users/super/Desktop/github大号仓库数据导出';

interface RepoMeta {
  type: string;
  url: string;
  name: string;
  description: string | null;
  private: boolean;
  default_branch?: string;
  has_issues?: boolean;
  has_wiki?: boolean;
  website?: string | null;
}

interface ReleaseMeta {
  type: string;
  url: string;
  repository: string;
  name: string;
  tag_name: string;
  body: string | null;
  state: string;
  prerelease: boolean;
  published_at?: string;
  created_at?: string;
}

interface IssueMeta {
  type: string;
  url: string;
  repository: string;
  title: string;
  body: string | null;
  labels?: string[];
  created_at?: string;
  closed_at?: string | null;
}

interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  visibility: string;
  default_branch: string | null;
  http_url_to_repo: string;
}

function sanitizeUrl(str: string): string {
  if (!GITLAB_TOKEN) return str;
  return str.replaceAll(GITLAB_TOKEN, '***');
}

function getValidGitLabPath(name: string): string {
  let p = name.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  if (p.endsWith('.git')) p = p.slice(0, -4);
  if (p.endsWith('.atom')) p = p.slice(0, -5);
  return p || 'repo';
}

async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {},
  retries = 3
): Promise<{ status: number; ok: boolean; data: T }> {
  const url = `${GITLAB_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': GITLAB_TOKEN!,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After')) || attempt * 2;
        console.warn(`⏳ Rate limited on ${endpoint}. Waiting ${retryAfter}s before retry...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      let data: any = null;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      return { status: res.status, ok: res.ok, data };
    } catch (err: any) {
      if (attempt === retries) {
        throw new Error(`API Request failed for ${endpoint}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  throw new Error(`Failed request after ${retries} attempts: ${endpoint}`);
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const gitArgs = ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args];
    return await execFileAsync('git', gitArgs, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch (err: any) {
    const safeError = sanitizeUrl(err.message || String(err));
    throw new Error(`Git error: ${safeError}`);
  }
}

async function getNamespaceId(username: string): Promise<number> {
  const res = await apiRequest<any[]>('/namespaces');
  if (!res.ok || !Array.isArray(res.data)) {
    throw new Error(`Failed to list namespaces: ${JSON.stringify(res.data)}`);
  }
  const match = res.data.find(
    (ns) => ns.path.toLowerCase() === username.toLowerCase() || ns.name.toLowerCase() === username.toLowerCase()
  );
  if (!match) {
    throw new Error(`Could not find namespace for ${username}`);
  }
  return match.id;
}

async function getAllUserProjects(username: string): Promise<Map<string, GitLabProject>> {
  const projectMap = new Map<string, GitLabProject>();
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await apiRequest<GitLabProject[]>(
      `/users/${username}/projects?per_page=${perPage}&page=${page}`
    );
    if (!res.ok || !Array.isArray(res.data)) {
      break;
    }
    for (const p of res.data) {
      projectMap.set(p.path.toLowerCase(), p);
    }
    if (res.data.length < perPage) {
      break;
    }
    page++;
  }
  return projectMap;
}

async function ensureProject(
  repo: RepoMeta,
  namespaceId: number,
  existingProjects: Map<string, GitLabProject>
): Promise<GitLabProject> {
  const targetPath = getValidGitLabPath(repo.name);
  const key = targetPath.toLowerCase();
  const existing = existingProjects.get(key);
  if (existing) {
    return existing;
  }

  const visibility = repo.private ? 'private' : 'public';
  const body = {
    name: repo.name,
    path: targetPath,
    namespace_id: namespaceId,
    description: repo.description || '',
    visibility,
    initialize_with_readme: false,
  };

  const res = await apiRequest<GitLabProject>('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (res.ok && res.data?.id) {
    existingProjects.set(key, res.data);
    return res.data;
  }

  if (res.status === 409) {
    // Project exists, fetch single project
    const encodedPath = encodeURIComponent(`${TARGET_USERNAME}/${targetPath}`);
    const getRes = await apiRequest<GitLabProject>(`/projects/${encodedPath}`);
    if (getRes.ok && getRes.data?.id) {
      existingProjects.set(key, getRes.data);
      return getRes.data;
    }
  }

  throw new Error(`Failed to create project ${repo.name}: ${JSON.stringify(res.data)}`);
}

async function syncGitRepo(projectPath: string, barePath: string): Promise<{ branchesPushed: boolean; tagsCount: number }> {
  const remoteUrl = `https://oauth2:${GITLAB_TOKEN}@gitlab.com/${TARGET_USERNAME}/${projectPath}.git`;

  // 1. Push all branches
  await runGit(['push', '--force', remoteUrl, '--all'], barePath);

  // 2. Check if tags exist and push tags
  const tagsResult = await runGit(['tag'], barePath);
  const tags = tagsResult.stdout
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

  if (tags.length > 0) {
    await runGit(['push', '--force', remoteUrl, '--tags'], barePath);
  }

  return { branchesPushed: true, tagsCount: tags.length };
}

async function syncReleases(
  project: GitLabProject,
  releases: ReleaseMeta[]
): Promise<number> {
  if (releases.length === 0) return 0;

  // Check existing releases
  const existingRes = await apiRequest<any[]>(`/projects/${project.id}/releases`);
  const existingTags = new Set(
    Array.isArray(existingRes.data) ? existingRes.data.map((r) => r.tag_name) : []
  );

  let synced = 0;
  for (const rel of releases) {
    if (existingTags.has(rel.tag_name)) continue;

    const body: Record<string, any> = {
      name: rel.name || rel.tag_name,
      tag_name: rel.tag_name,
      description: rel.body || '',
    };
    if (rel.published_at || rel.created_at) {
      body.released_at = rel.published_at || rel.created_at;
    }

    const res = await apiRequest(`/projects/${project.id}/releases`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (res.ok || res.status === 409) {
      synced++;
    }
  }
  return synced;
}

async function syncIssues(
  project: GitLabProject,
  issues: IssueMeta[]
): Promise<number> {
  if (issues.length === 0) return 0;

  // Check existing issues
  const existingRes = await apiRequest<any[]>(`/projects/${project.id}/issues?per_page=100`);
  const existingTitles = new Set(
    Array.isArray(existingRes.data) ? existingRes.data.map((i) => i.title) : []
  );

  let synced = 0;
  for (const issue of issues) {
    if (existingTitles.has(issue.title)) continue;

    const labelNames = (issue.labels || []).map((l) => {
      const parts = l.split('/');
      return decodeURIComponent(parts[parts.length - 1]);
    });

    const body: Record<string, any> = {
      title: issue.title,
      description: issue.body || '',
      labels: labelNames.join(','),
    };
    if (issue.created_at) {
      body.created_at = issue.created_at;
    }

    const res = await apiRequest<any>(`/projects/${project.id}/issues`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (res.ok && res.data?.iid) {
      if (issue.closed_at) {
        await apiRequest(`/projects/${project.id}/issues/${res.data.iid}`, {
          method: 'PUT',
          body: JSON.stringify({ state_event: 'close' }),
        });
      }
      synced++;
    }
  }
  return synced;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      await fn(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const startTime = Date.now();
  console.log('====================================================');
  console.log('🚀 GitHub Export to GitLab Synchronizer');
  console.log('====================================================');
  console.log(`📁 Source directory: ${EXPORT_DIR}`);
  console.log(`🎯 Destination: https://gitlab.com/${TARGET_USERNAME}`);

  // 1. Verify source data
  const reposJsonPath = path.join(EXPORT_DIR, 'repositories_000001.json');
  if (!fs.existsSync(reposJsonPath)) {
    throw new Error(`Repositories JSON not found at ${reposJsonPath}`);
  }
  const reposMeta: RepoMeta[] = JSON.parse(fs.readFileSync(reposJsonPath, 'utf8'));
  console.log(`📦 Found ${reposMeta.length} repositories in export metadata.`);

  // Load releases
  let allReleases: ReleaseMeta[] = [];
  const releasesJsonPath = path.join(EXPORT_DIR, 'releases_000001.json');
  if (fs.existsSync(releasesJsonPath)) {
    allReleases = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'));
    console.log(`🏷️  Found ${allReleases.length} releases in export metadata.`);
  }

  // Load issues
  let allIssues: IssueMeta[] = [];
  const issuesJsonPath = path.join(EXPORT_DIR, 'issues_000001.json');
  if (fs.existsSync(issuesJsonPath)) {
    allIssues = JSON.parse(fs.readFileSync(issuesJsonPath, 'utf8'));
    console.log(`💬 Found ${allIssues.length} issues in export metadata.`);
  }

  // 2. Resolve namespace ID
  const namespaceId = await getNamespaceId(TARGET_USERNAME);
  console.log(`🔑 Verified namespace "${TARGET_USERNAME}" (ID: ${namespaceId})`);

  // 3. Get existing projects on GitLab
  const existingProjects = await getAllUserProjects(TARGET_USERNAME);
  console.log(`📋 Found ${existingProjects.size} existing projects on GitLab.`);

  // 4. Prepare repos
  const bareReposBase = path.join(EXPORT_DIR, 'repositories', TARGET_USERNAME);
  const syncQueue = reposMeta.map((repo) => {
    const barePath = path.join(bareReposBase, `${repo.name}.git`);
    return {
      repo,
      barePath,
      existsOnDisk: fs.existsSync(barePath),
    };
  });

  const missingOnDisk = syncQueue.filter((item) => !item.existsOnDisk);
  if (missingOnDisk.length > 0) {
    console.warn(`⚠️ Warning: ${missingOnDisk.length} repos have metadata but missing bare git folder.`);
  }

  const validItems = syncQueue.filter((item) => item.existsOnDisk);
  console.log(`✨ Starting synchronization for ${validItems.length} repositories...\n`);

  let successCount = 0;
  let failCount = 0;
  const errors: { repo: string; error: string }[] = [];

  // Run with concurrency 2
  await runPool(validItems, 2, async ({ repo, barePath }, i) => {
    const prefix = `[${i + 1}/${validItems.length}] [${repo.name}]`;

    try {
      // 1. Ensure project exists
      const project = await ensureProject(repo, namespaceId, existingProjects);

      // 2. Git push branches and tags
      const { tagsCount } = await syncGitRepo(project.path, barePath);

      // 3. Update default branch if needed
      if (repo.default_branch && repo.default_branch !== project.default_branch) {
        await apiRequest(`/projects/${project.id}`, {
          method: 'PUT',
          body: JSON.stringify({ default_branch: repo.default_branch }),
        });
      }

      // 4. Sync releases
      const repoReleases = allReleases.filter(
        (r) => r.repository.toLowerCase().endsWith(`/${repo.name.toLowerCase()}`)
      );
      const releasesSynced = await syncReleases(project, repoReleases);

      // 5. Sync issues
      const repoIssues = allIssues.filter(
        (is) => is.repository.toLowerCase().endsWith(`/${repo.name.toLowerCase()}`)
      );
      const issuesSynced = await syncIssues(project, repoIssues);

      console.log(
        `${prefix} ✅ Synced (visibility: ${repo.private ? 'private' : 'public'}, tags: ${tagsCount}, releases: ${releasesSynced}, issues: ${issuesSynced})`
      );
      successCount++;
    } catch (err: any) {
      console.error(`${prefix} ❌ Error: ${err.message}`);
      errors.push({ repo: repo.name, error: err.message });
      failCount++;
    }
  });

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log('\n====================================================');
  console.log(`🎉 Sync Completed in ${durationSec}s!`);
  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Failed:  ${failCount}`);
  if (errors.length > 0) {
    console.log('\nFailed repositories:');
    for (const e of errors) {
      console.log(` - ${e.repo}: ${e.error}`);
    }
  }
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
