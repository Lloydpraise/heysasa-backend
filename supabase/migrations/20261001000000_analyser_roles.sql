-- Analyser v3: who the other person is (customer / vendor / staff / personal / junk).
-- Additive only. Safe to run more than once. Run this BEFORE the next analyser run.
--
-- contacts.lead_type now also holds 'vendor' (the owner is the buyer, or the other
-- person sells to / serves / chases the owner) and 'staff' (employees, hires,
-- job applicants), next to 'business' (a real customer), 'personal', 'junk', 'unknown'.
-- Nothing in the database constrains lead_type, so no constraint change is needed.
--
-- classifier_version records which classifier rules produced a contact's lead_type.
-- Contacts classified under an older version (null) are re-classified once on the
-- next run; manual labels are never touched.

alter table public.contacts
  add column if not exists classifier_version integer;

comment on column public.contacts.classifier_version is
  'Analyser classifier rules version that produced lead_type. Null or older = re-classify on next run.';
