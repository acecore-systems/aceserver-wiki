import { describe, expect, it } from 'vitest'

import adapter from '../functions/admin/api/ai/[[path]].ts?raw'
import admin from '../public/admin/index.html?raw'
import client from '../public/admin/ai-panel.js?raw'
import config from '../wrangler.jsonc?raw'
import workflow from '../../../.github/workflows/cms-ai.yml?raw'

describe('CMS AI integration', () => {
  it('共通会話UIとService Bindingだけをサイトへ組み込む', () => {
    expect(admin).toMatch(/\/admin\/ai-panel\.css/)
    expect(admin).toMatch(/\/admin\/ai-panel\.js/)
    expect(client).toMatch(/\/admin\/api\/ai/)
    expect(client).toMatch(/sessionEndpoint/)
    expect(client).toMatch(/reasoningEffort/)
    expect(client).toMatch(/\/messages/)
    expect(client).toMatch(/session\?\.role/)
    expect(client).not.toMatch(/targetUrl|referenceImage/)
    expect(adapter).toMatch(/CMS_AI\.fetch\(request\)/)
    expect(adapter).not.toMatch(/AI\.run|CMS_AI_MODEL|GITHUB_TOKEN/)
    expect(config).toMatch(/"binding":\s*"CMS_AI"[\s\S]*?"service":\s*"cms-ai"/)
    expect(workflow).toMatch(/workflow_dispatch:/)
    expect(workflow).not.toMatch(/repository_dispatch:/)
    expect(workflow).toMatch(/contents: write/)
    expect(workflow).toMatch(/id-token: write/)
    expect(workflow).toMatch(/pull-requests: write/)
    expect(workflow).toMatch(/persist-credentials: false/)
    expect(workflow).toMatch(/timeout-minutes: 45/)
    expect(workflow).toMatch(/acecore-systems\/cms-ai\/runner@v1/)
    expect(workflow).not.toMatch(/pr merge|auto.?merge/i)
  })
})
