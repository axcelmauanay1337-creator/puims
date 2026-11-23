-- PUIMS PostgreSQL starter schema
-- Review with hospital IT/security and clinical governance before production.
-- All patient data must be stored only in an approved, secured environment.

create extension if not exists pgcrypto;

create type public.app_role as enum ('chief_rt_admin','respiratory_therapist');
create type public.patient_location as enum ('OPD','INP','OTHER');
create type public.service_type as enum ('NEBULIZATION','MECHANICAL_VENTILATION','PFT','ABG','SPUTUM_INDUCTION');
create type public.shift_code as enum ('MORNING','AFTERNOON','NIGHT');
create type public.event_status as enum ('SCHEDULED','PENDING','IN_PROGRESS','COMPLETED','DELAYED','NOT_GIVEN','REFUSED','CANCELLED','NO_SHOW');

create table public.rt_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null,
  role public.app_role not null default 'respiratory_therapist',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  hospital_patient_id text unique not null,
  full_name text not null,
  date_of_birth date,
  sex text check (sex in ('M','F','X','UNKNOWN')),
  location_type public.patient_location,
  ward_room text,
  created_at timestamptz not null default now(),
  created_by uuid references public.rt_profiles(id),
  updated_at timestamptz not null default now()
);

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  operational_date date not null,
  shift public.shift_code not null,
  rt_user_id uuid not null references public.rt_profiles(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table public.service_events (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id),
  service public.service_type not null,
  event_status public.event_status not null,
  occurred_at timestamptz,
  scheduled_at timestamptz,
  completed_at timestamptz,
  shift public.shift_code,
  operational_date date,
  performed_by uuid references public.rt_profiles(id),
  source_reference text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.rt_profiles(id),
  updated_at timestamptz not null default now()
);
create index service_events_patient_time_idx on public.service_events(patient_id, occurred_at);
create index service_events_service_schedule_idx on public.service_events(service, scheduled_at);

create table public.nebulization_orders (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id),
  medication_name text not null,
  prescribed_frequency text not null,
  order_text text,
  start_at timestamptz not null,
  end_at timestamptz,
  prescriber_name text,
  order_reference text,
  entered_by uuid references public.rt_profiles(id),
  created_at timestamptz not null default now()
);

create table public.nebulization_administrations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.nebulization_orders(id),
  service_event_id uuid unique references public.service_events(id),
  scheduled_at timestamptz,
  actual_at timestamptz,
  status public.event_status not null default 'SCHEDULED',
  performed_by uuid references public.rt_profiles(id),
  reason_if_not_given text,
  created_at timestamptz not null default now()
);

create table public.ventilator_encounters (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id),
  hooked_at timestamptz not null,
  disconnected_at timestamptz,
  ventilator_brand_model text,
  ventilator_serial_number text,
  ward_room text,
  encounter_status text not null default 'ACTIVE' check (encounter_status in ('ACTIVE','DISCONTINUED')),
  created_by uuid references public.rt_profiles(id),
  created_at timestamptz not null default now(),
  check (disconnected_at is null or disconnected_at >= hooked_at)
);

create table public.tubing_replacements (
  id uuid primary key default gen_random_uuid(),
  ventilator_encounter_id uuid not null references public.ventilator_encounters(id),
  tubing_type text not null default 'Chamfecof',
  installed_at timestamptz not null,
  interval_days integer not null default 7 check (interval_days > 0),
  next_due_at timestamptz generated always as (installed_at + make_interval(days => interval_days)) stored,
  replaced_by uuid references public.rt_profiles(id),
  replacement_reason text,
  created_at timestamptz not null default now()
);
create index tubing_due_idx on public.tubing_replacements(next_due_at);

create table public.diagnostic_appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id),
  service public.service_type not null check (service in ('PFT','ABG','SPUTUM_INDUCTION')),
  scheduled_at timestamptz not null,
  status public.event_status not null default 'SCHEDULED',
  requesting_physician text,
  payment_classification text,
  rt_scheduler_id uuid references public.rt_profiles(id),
  performed_by uuid references public.rt_profiles(id),
  source_sheet text,
  source_row_number integer,
  source_record_hash text,
  remarks text,
  created_at timestamptz not null default now()
);
create index diagnostic_schedule_time_idx on public.diagnostic_appointments(scheduled_at);

create table public.shift_handovers (
  id uuid primary key default gen_random_uuid(),
  operational_date date not null,
  shift public.shift_code not null,
  outgoing_rt_id uuid references public.rt_profiles(id),
  incoming_rt_id uuid references public.rt_profiles(id),
  summary jsonb not null default '{}'::jsonb,
  pending_items jsonb not null default '[]'::jsonb,
  equipment_concerns text,
  handover_notes text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (operational_date, shift)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.rt_profiles(id),
  action text not null,
  table_name text not null,
  record_id text not null,
  before_data jsonb,
  after_data jsonb,
  occurred_at timestamptz not null default now()
);

-- IMPORTANT:
-- 1. Enable RLS on every patient/clinical table before any deployment.
-- 2. Define least-privilege policies using authenticated user role.
-- 3. Do not expose service-role keys in browser code.
-- 4. Add immutable audit triggers and server-side shift classification.
-- 5. Validate all date/time imports and preserve source-row provenance.
-- 6. Confirm the tubing interval and clinical workflows against hospital policy.
