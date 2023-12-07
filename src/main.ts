import * as core from '@actions/core'
import * as glob from '@actions/glob'
import { getOctokit } from '@actions/github'
import * as httpm from '@actions/http-client'
import * as httpmauth from '@actions/http-client/lib/auth'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { parse } from 'yaml'

process.on('unhandledRejection', handleError)
// eslint-disable-next-line github/no-then
main().catch(handleError)

type GitHub = ReturnType<typeof getOctokit>

interface GitHubWorkflow {
  name: string
  // Ideally, we want to have just patterns and match if modified files match
  // with the patterns. But because the workflow matching pattern has a bit more
  // than just a pattern match, we use GitHub's glob to expand it actual files.
  files: string[]
}

async function main(): Promise<void> {
  const octokit = getOctokit(core.getInput('github-token', { required: true }))
  const prNumber = getPRNumber()
  if (!prNumber) {
    core.setFailed('Cannot find the PR number based on GITHUB_REF')
    return
  }
  if (!process.env.GITHUB_REPOSITORY) {
    core.setFailed(
      'Cannot find the GitHub repository name on GITHUB_REPOSITORY'
    )
    return
  }
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
  core.info(`Repository ${owner}/${repo} PullRequest: ${prNumber}`)

  const modifiedFiles = await getModifiedFiles(octokit, owner, repo, prNumber)
  core.info(`Modified files:`)
  for (const mf of modifiedFiles) {
    core.info(` - ${mf}`)
  }

  const workflows = await getGitHubWorkflows()
  core.info(`Found workflows:`)
  for (const wf of workflows) {
    core.info(` - ${wf.name}`)
  }
  const affectedWorkflows = workflows.filter(wf =>
    shouldTriggerWorkflow(wf, modifiedFiles)
  )
  core.info(`Affected workflows:`)
  for (const wf of affectedWorkflows) {
    core.info(` - ${wf.name}`)
  }

  core.info(`Updating the affected target info in Aviator...`)
  await postAffectedTargets(owner, repo, prNumber, affectedWorkflows)
}

function getPRNumber(): number | null {
  if (!process.env.GITHUB_REF) {
    return null
  }
  const m = process.env.GITHUB_REF.match(/^refs\/pull\/(\d*)\/merge$/)
  if (!m) {
    return null
  }
  return parseInt(m[1])
}

async function getModifiedFiles(
  octokit: GitHub,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const paths = []
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listFiles,
    { owner, repo, pull_number: prNumber }
  )) {
    for (const modified of response.data) {
      paths.push(modified.filename)
    }
  }
  return paths
}

async function getGitHubWorkflows(): Promise<GitHubWorkflow[]> {
  const globber = await glob.create(
    ['.github/workflows/*.yml', '.github/workflows/*.yaml'].join('\n')
  )
  const workflows = []
  for await (const file of globber.globGenerator()) {
    const wf = await parseGitHubWorkflowFile(file)
    if (wf) {
      workflows.push(wf)
    }
  }
  return workflows
}

function shouldTriggerWorkflow(
  wf: GitHubWorkflow,
  modified: string[]
): boolean {
  return wf.files.some(p => modified.includes(p))
}

async function parseGitHubWorkflowFile(
  filepath: string
): Promise<GitHubWorkflow | null> {
  const data = await fs.readFile(filepath, { encoding: 'utf8' })
  const doc = parse(data)
  const name = path.basename(filepath, path.extname(filepath))
  const matchPaths = doc.on?.pull_request?.['paths'] as string[] | undefined
  const ignorePaths = doc.on?.pull_request?.['paths-ignore'] as
    | string[]
    | undefined
  const cwd = process.cwd()
  if (matchPaths) {
    const globber = await glob.create(
      matchPaths.map(globberPatternFix).join('\n')
    )
    return {
      name,
      files: (await globber.glob()).map(p => path.relative(cwd, p))
    }
  }
  if (ignorePaths) {
    const globber = await glob.create(
      ignorePaths
        .map(globberPatternFix)
        .map(p => `!${p}`)
        .join('\n')
    )
    return {
      name,
      files: (await globber.glob()).map(p => path.relative(cwd, p))
    }
  }
  // Not a file based workflow.
  return null
}

async function postAffectedTargets(
  owner: string,
  repo: string,
  prNumber: number,
  workflows: GitHubWorkflow[]
): Promise<void> {
  const http = new httpm.HttpClient('aviator-affected-targets-gha-action', [
    new httpmauth.BearerCredentialHandler(
      core.getInput('aviator-token', { required: true })
    )
  ])
  await http.postJson(core.getInput('aviator-api-url', { required: true }), {
    action: 'update',
    pull_request: {
      number: prNumber,
      repository: {
        org: owner,
        name: repo
      },
      affected_targets: workflows.map(wf => wf.name)
    }
  })
  return
}

function globberPatternFix(pattern: string): string {
  // actions/globber's ** interpretation is different from GitHub Action's
  // interpretation. Fix this up.
  let prefix = ''
  if (pattern.startsWith('!')) {
    pattern = pattern.substring(1)
    prefix = '!'
  }
  const segments = pattern.split(path.sep)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== '**' && segments[i].startsWith('**')) {
      // Convert '**.go' into '**/*.go'.
      segments[i] = `**${path.sep}${segments[i].substring(1)}`
    }
  }
  return prefix + segments.join(path.sep)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(err: any): void {
  console.error(err)
  core.setFailed(`Unhandled error: ${err}`)
}
