import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SDK_GUIDE_TOPICS, SDK_VERSION, sdkGuide, sdkGuideTools } from '../server/ai/sdkGuide.ts';
import { SYSTEM_PROMPT } from '../server/ai/prompt.ts';

const sdkPackage = JSON.parse(readFileSync(new URL('../../../error-tracking-sdk/js/package.json', import.meta.url), 'utf8')) as { version: string };

describe('AI: SDK guide', () => {
  it('knows the version of the SDK this app is built with', () => {
    assert.equal(SDK_VERSION, sdkPackage.version);
    assert.ok(SYSTEM_PROMPT.includes(`Current JS SDK version: **${SDK_VERSION}**`));
  });

  it('has the integration topics people ask about, each with real content', () => {
    for (const topic of ['install', 'html', 'react', 'nextjs', 'vue_angular_other', 'appzillon', 'configuration', 'troubleshooting', 'versions'] as const) {
      assert.ok(SDK_GUIDE_TOPICS.includes(topic), topic);
    }
    for (const topic of SDK_GUIDE_TOPICS) assert.ok(sdkGuide(topic).length > 400, topic);
  });

  it('pins the current version in CDN snippets and lists it first in the history', () => {
    assert.ok(sdkGuide('html').includes(`@sourav732/error-tracker-js@${SDK_VERSION}/dist/index.mjs`));
    assert.ok(sdkGuide('versions').includes(`- **${SDK_VERSION}**`));
  });

  it('lists every init() option the SDK accepts', () => {
    const types = readFileSync(new URL('../../../error-tracking-sdk/js/src/types.ts', import.meta.url), 'utf8');
    const config = /export interface ErrorTrackerConfig \{([\s\S]*?)\n\}/.exec(types);
    assert.ok(config);
    const options = [...config[1].matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
    assert.ok(options.length > 20);
    const table = sdkGuide('configuration');
    for (const option of options) assert.ok(table.includes(option), option);
  });

  it('serves topics through the tool and rejects unknown ones', async () => {
    const guide = sdkGuideTools().read_sdk_guide;
    const execute = guide.execute as unknown as (input: { topic: string }, options: unknown) => Promise<{ version: string; text: string }>;
    const result = await execute({ topic: 'nextjs' }, { toolCallId: 't', messages: [] });
    assert.equal(result.version, SDK_VERSION);
    assert.ok(result.text.includes('instrumentation-client.ts'));
    const schema = guide.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    assert.equal(schema.safeParse({ topic: 'php' }).success, false);
  });
});

describe('AI: scope', () => {
  it('both assistants refuse unrelated questions', async () => {
    const { WORKSPACE_PROMPT } = await import('../server/ai/workspacePrompt.ts');
    for (const prompt of [SYSTEM_PROMPT, WORKSPACE_PROMPT]) {
      assert.ok(prompt.includes('# Scope: only this error tracker'));
      assert.ok(prompt.includes('Anything else is out of scope'));
    }
  });
});
