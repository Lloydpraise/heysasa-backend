import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPhone, extractMessageJids, isLidJid, isPhoneJid, isUsableContactName } from './dataCleaner.js'

test('a LID is never turned into a phone number', () => {
  assert.equal(extractPhone('268289544593496@lid'), null)
  assert.equal(extractPhone('254712345678@s.whatsapp.net'), '+254712345678')
  assert.equal(extractPhone(null), null)
})

test('jid type checks', () => {
  assert.equal(isLidJid('1@lid'), true)
  assert.equal(isPhoneJid('254712345678@s.whatsapp.net'), true)
  assert.equal(isPhoneJid('1@lid'), false)
})

test('extractMessageJids returns both identities when WhatsApp sent both', () => {
  const both = { key: { remoteJid: '268289544593496@lid', remoteJidAlt: '254712345678@s.whatsapp.net' } }
  assert.deepEqual(extractMessageJids(both), { jid: '254712345678@s.whatsapp.net', altJid: '268289544593496@lid' })

  const pnWithLidAlt = { key: { remoteJid: '254712345678@s.whatsapp.net', remoteJidAlt: '268289544593496@lid' } }
  assert.deepEqual(extractMessageJids(pnWithLidAlt), { jid: '254712345678@s.whatsapp.net', altJid: '268289544593496@lid' })

  const lidOnly = { key: { remoteJid: '268289544593496@lid' } }
  assert.deepEqual(extractMessageJids(lidOnly), { jid: '268289544593496@lid', altJid: null })
})

test('names: placeholders, numbers and the owner are rejected; real names kept', () => {
  assert.equal(isUsableContactName('Wanjiru'), true)
  assert.equal(isUsableContactName('Você'), false)
  assert.equal(isUsableContactName('Unknown'), false)
  assert.equal(isUsableContactName('254712345678'), false)
  assert.equal(isUsableContactName('+254 712 345 678'), false)
  assert.equal(isUsableContactName(''), false)
  assert.equal(isUsableContactName(null), false)
  assert.equal(isUsableContactName('Kitchen And All', ['kitchen and all']), false)
  assert.equal(isUsableContactName('Kitchen Staff', ['Kitchen And All']), true)
})
