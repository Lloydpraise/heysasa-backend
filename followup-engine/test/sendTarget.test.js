import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSendTarget, contactDisplayName, isLidJid } from '../src/lib/sendTarget.js'
import { resolveEvolutionNumber } from '../src/sender-baileys/evolutionSender.js'
import { classifyFailure, decideRetry } from '../src/lib/sendFailures.js'
import { resolveMergeFields } from '../src/lib/mergeFields.js'

test('a real phone number is the first choice', () => {
  const t = resolveSendTarget({ phone: '+254712345678', social_id: '268289544593496@lid' })
  assert.deepEqual(t, { kind: 'phone', number: '254712345678', label: '254712345678' })
})

test('a LID contact with no phone is sent to by LID JID', () => {
  const t = resolveSendTarget({ phone: null, social_id: '268289544593496@lid' })
  assert.equal(t.kind, 'lid')
  assert.equal(t.number, '268289544593496@lid')
})

test('a LID saved as the phone (old intake bug) is NOT treated as a number', () => {
  const t = resolveSendTarget({ phone: '+268289544593496', social_id: '268289544593496@lid' })
  assert.equal(t.kind, 'lid')
  assert.equal(t.number, '268289544593496@lid')
})

test('phone-JID social_id is used when the phone column is empty', () => {
  const t = resolveSendTarget({ phone: null, social_id: '254712345678@s.whatsapp.net' })
  assert.deepEqual(t, { kind: 'phone', number: '254712345678', label: '254712345678' })
})

test('local-format numbers are normalised as before', () => {
  assert.equal(resolveSendTarget({ phone: '0712 345 678', social_id: null }).number, '254712345678')
})

test('nothing usable -> null (caller must not send)', () => {
  assert.equal(resolveSendTarget({ phone: null, social_id: null }), null)
  assert.equal(resolveSendTarget({ phone: '', social_id: 'something-else' }), null)
  assert.equal(resolveSendTarget(null), null)
})

test('a group JID can never become a send target', () => {
  assert.equal(resolveSendTarget({ phone: null, social_id: '120363025246125486@g.us' }), null)
  assert.equal(resolveEvolutionNumber('120363025246125486@g.us'), '')
  assert.equal(resolveEvolutionNumber('status@broadcast'), '')
})

test('Evolution number: LID and phone JIDs pass through, phones are normalised', () => {
  assert.equal(resolveEvolutionNumber('268289544593496@lid'), '268289544593496@lid')
  assert.equal(resolveEvolutionNumber('254712345678@s.whatsapp.net'), '254712345678@s.whatsapp.net')
  assert.equal(resolveEvolutionNumber('0712345678'), '254712345678')
  assert.equal(resolveEvolutionNumber({ number: '268289544593496@lid' }), '268289544593496@lid')
  assert.equal(resolveEvolutionNumber(''), '')
})

test('isLidJid', () => {
  assert.equal(isLidJid('123@lid'), true)
  assert.equal(isLidJid('123@s.whatsapp.net'), false)
  assert.equal(isLidJid(null), false)
})

test('no_send_target is a permanent, non-retried failure', () => {
  assert.equal(classifyFailure('no_send_target'), 'no_send_target')
  assert.equal(decideRetry('no_send_target', 1).giveUp, true)
})

test('alert/display names never print null or a bare number as a name', () => {
  assert.equal(contactDisplayName({ name: 'Wanjiru', phone: '+254712345678' }), 'Wanjiru')
  assert.equal(contactDisplayName({ name: null, phone: '+254712345678', social_id: null }), '254712345678')
  assert.equal(contactDisplayName({ name: null, phone: null, social_id: '268289544593496@lid' }), 'a customer')
  assert.equal(contactDisplayName({ name: '254712345678', phone: null, social_id: '1@lid' }), 'a customer')
})

test('merge field greets numeric / placeholder names as "there"', () => {
  assert.equal(resolveMergeFields('Hi {{first_name}}', { name: '254712345678' }), 'Hi there')
  assert.equal(resolveMergeFields('Hi {{first_name}}', { name: 'Você' }), 'Hi there')
  assert.equal(resolveMergeFields('Hi {{first_name}}', { name: 'Wanjiru Kamau' }), 'Hi Wanjiru')
})
