import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHandoffConfig, renderHandoffRules, resolveRecipients } from './config.js';

const raw = {
    recipients: [{ id: 'w', name: 'Wanjiru', phone: '0722 333 444' }, { name: 'No number', phone: '123' }, { name: '', phone: '0711000111' }],
    rules: [
        { id: 'refund', label: 'Refund', when: 'wants a refund', to: ['w', 'owner', 'ghost'], urgency: 'high' },
        { label: 'No description' },
        { label: 'Bad urgency', when: 'anything', urgency: 'extreme' },
    ],
};

test('bad people and rules are dropped and named, good ones are cleaned', () => {
    const { config, errors } = normalizeHandoffConfig(raw);
    assert.deepEqual(config.recipients, [{ id: 'w', name: 'Wanjiru', phone: '254722333444' }]);
    assert.equal(errors.length, 3);
    assert.deepEqual(config.rules[0].to, ['w', 'owner'], 'unknown people are removed from a rule');
    assert.equal(config.rules[1].urgency, 'normal');
    assert.deepEqual(config.default_to, ['owner']);
    assert.equal(config.alert_whatsapp, true);
});

test('nothing set means the owner is told, on WhatsApp', () => {
    const { config, errors } = normalizeHandoffConfig(undefined);
    assert.deepEqual([config.recipients, config.rules, config.default_to, config.alert_whatsapp, errors], [[], [], ['owner'], true, []]);
    assert.deepEqual(resolveRecipients(undefined, null, '0711000111').recipients, [{ name: 'Owner', phone: '254711000111' }]);
    assert.deepEqual(resolveRecipients(undefined, null, null).recipients, [], 'no number on file means nobody to message (Home still shows it)');
});

test('a rule picks its people, an unknown rule falls back to the default, duplicates are told once', () => {
    const { config } = normalizeHandoffConfig(raw);
    const hit = resolveRecipients(config, 'refund', '0711000111');
    assert.deepEqual(hit.recipients.map((r) => r.name), ['Wanjiru', 'Owner']);
    assert.equal(hit.rule.urgency, 'high');
    assert.deepEqual(resolveRecipients(config, 'nope', '0711000111').recipients.map((r) => r.name), ['Owner']);
    const same = resolveRecipients({ recipients: [{ id: 'w', name: 'Me', phone: '0711000111' }], default_to: ['owner', 'w'] }, null, '0711000111');
    assert.equal(same.recipients.length, 1);
});

test('the AI is told each case with its rule_id, and nothing when there are no cases', () => {
    const { config } = normalizeHandoffConfig(raw);
    assert.match(renderHandoffRules(config), /Refund: wants a refund\. Hand off with rule_id "refund" \(Wanjiru and the owner will be told, urgent\)/);
    assert.equal(renderHandoffRules({}), '');
});
