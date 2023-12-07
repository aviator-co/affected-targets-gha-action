# Aviator MergeQueue affected targets calculator for GitHub Actions workflows

Calculate [affected
targets](https://docs.aviator.co/mergequeue/concepts/affected-targets) for
Aviator MergeQueue based on GitHub Actions workflows.

## Example

```yaml
steps:
- uses: actions/checkout@v4
- uses: aviator-co/affected-targets-gha-action@v1
  with:
    aviator-token: ${{ secrets.AVIATOR_TOKEN }}
```

## How it works

Affected targets is a feature that allows you to split the MergeQueue based on
the test/build targets that a PR affects. For example, if a PR changes only Go
files, you wouldn't need to queue PRs sequentially with Python modifying PRs
because they are completely isolated, different project.

This GitHub Actions infer which build/test targets a PR affects based on [GitHub
Actions Workflow's paths
specification](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore).

In the workflow config, you can specify when to run a workflow. For example:

```yaml
on:
  push:
    paths:
      - '**.go'
```

If you specify like this, this workflow only runs when Go files are modified.
By reading this workflow spec, this GitHub Action automatically infers the
affected targets.
