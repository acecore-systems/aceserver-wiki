import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rollbackWorkflowUrl = new URL(
  '../.github/workflows/cms-rollback.yml',
  import.meta.url,
)
const vectorizeWorkflowUrl = new URL(
  '../.github/workflows/sync-vectorize.yml',
  import.meta.url,
)

function getStepBlock(workflow, name) {
  const lines = workflow.split(/\r?\n/u)
  const start = lines.findIndex((line) => line === `      - name: ${name}`)

  assert.notEqual(start, -1, `Workflow step not found: ${name}`)

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - name: ')) {
      end = index
      break
    }
  }

  return lines.slice(start, end).join('\n')
}

test('CMS rollback always checks out main before pushing to main', async () => {
  const workflow = await readFile(rollbackWorkflowUrl, 'utf8')
  const checkoutStep = getStepBlock(workflow, 'Checkout main with history')
  const buildStep = getStepBlock(workflow, 'Build and validate rollback')
  const pushStep = getStepBlock(workflow, 'Push validated rollback')

  assert.match(checkoutStep, /^ {10}ref: main$/mu)
  assert.match(checkoutStep, /^ {10}fetch-depth: 0$/mu)
  assert.match(buildStep, /^\s+run: npm run build$/mu)
  assert.match(pushStep, /^\s+git push origin HEAD:main$/mu)
  assert.ok(
    workflow.indexOf('      - name: Build and validate rollback') <
      workflow.indexOf('      - name: Push validated rollback'),
  )
  assert.doesNotMatch(workflow, /git push[^\n]*--force/u)
})

test('Vectorize secrets are used only by protected-main sync steps', async () => {
  const workflow = await readFile(vectorizeWorkflowUrl, 'utf8')
  const protectedCheckout = getStepBlock(
    workflow,
    'Check out protected main tooling',
  )
  const previewSync = getStepBlock(workflow, 'Sync preview Vectorize index')
  const productionSync = getStepBlock(
    workflow,
    'Sync production Vectorize index',
  )

  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/u)
  assert.match(protectedCheckout, /^ {10}ref: refs\/heads\/main$/mu)
  assert.match(protectedCheckout, /^ {10}persist-credentials: false$/mu)
  assert.match(
    previewSync,
    /secrets\.CLOUDFLARE_WIKI_SEARCH_PREVIEW_API_TOKEN/u,
  )
  assert.match(
    productionSync,
    /secrets\.CLOUDFLARE_WIKI_SEARCH_PRODUCTION_API_TOKEN/u,
  )
  assert.equal(
    workflow.match(/CLOUDFLARE_WIKI_SEARCH_PREVIEW_API_TOKEN/gmu)?.length,
    2,
  )
  assert.equal(
    workflow.match(/CLOUDFLARE_WIKI_SEARCH_PRODUCTION_API_TOKEN/gmu)?.length,
    2,
  )
  assert.match(
    workflow,
    /https:\/\/asv-wiki\.acecore\.net\/\.well-known\/aceserver-wiki-build\.json/u,
  )
  assert.ok(
    workflow.indexOf('      - name: Confirm the built commit is still public') <
      workflow.indexOf('      - name: Sync production Vectorize index'),
  )
  assert.doesNotMatch(workflow, /git push/u)
})
