-- Shashogo Woreda: workflow module (adds only new tables, old tables untouched)
-- Run on the TEST database first.
-- citizen_id / officer_id point to your existing user tables.
-- Foreign keys are left out on purpose so nothing old is affected; add them later.

BEGIN;

CREATE TABLE services (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(30) UNIQUE NOT NULL,      -- e.g. BIRTH_CERT
  name_en       VARCHAR(150) NOT NULL,
  name_am       VARCHAR(150),                     -- Amharic name
  description   TEXT,
  fee_etb       NUMERIC(10,2) NOT NULL DEFAULT 0,
  sla_days      INT NOT NULL DEFAULT 5,           -- time limit to finish
  office_level  VARCHAR(10) NOT NULL DEFAULT 'kebele', -- kebele | woreda
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_documents (
  id           SERIAL PRIMARY KEY,
  service_id   INT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  doc_name     VARCHAR(150) NOT NULL,             -- e.g. "Hospital birth notice"
  is_required  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE SEQUENCE application_seq START 1;

CREATE TABLE applications (
  id            BIGSERIAL PRIMARY KEY,
  tracking_no   VARCHAR(30) UNIQUE NOT NULL,      -- SHW-2026-000001
  service_id    INT NOT NULL REFERENCES services(id),
  citizen_id    BIGINT NOT NULL,                  -- existing citizen record
  kebele        VARCHAR(80),
  status        VARCHAR(20) NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted','in_review','needs_info',
                                  'approved','rejected','issued','cancelled')),
  assigned_to   BIGINT,                           -- existing employee record
  form_data     JSONB NOT NULL DEFAULT '{}',      -- service-specific fields
  due_at        TIMESTAMPTZ NOT NULL,             -- submitted_at + sla_days
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_status   ON applications(status);
CREATE INDEX idx_app_citizen  ON applications(citizen_id);
CREATE INDEX idx_app_assigned ON applications(assigned_to);
CREATE INDEX idx_app_due      ON applications(due_at);

CREATE TABLE application_files (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  doc_name       VARCHAR(150),
  file_path      TEXT NOT NULL,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail: every step, who did it, when. Never update or delete rows here.
CREATE TABLE case_history (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  actor_id       BIGINT NOT NULL,
  actor_role     VARCHAR(20) NOT NULL,
  from_status    VARCHAR(20),
  to_status      VARCHAR(20) NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hist_app ON case_history(application_id);

-- Starter services for the pilot
INSERT INTO services (code, name_en, sla_days, fee_etb, office_level) VALUES
 ('BIRTH_CERT', 'Birth certificate', 3, 0, 'kebele'),
 ('COMPLAINT',  'Complaint / feedback', 7, 0, 'woreda'),
 ('SUPPORT_LTR','Support letter request', 2, 0, 'kebele');

INSERT INTO service_documents (service_id, doc_name)
SELECT id, d FROM services, unnest(ARRAY['Hospital birth notice','Parents ID']) d
WHERE code = 'BIRTH_CERT';

COMMIT;
