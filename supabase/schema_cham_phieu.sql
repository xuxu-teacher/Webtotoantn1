-- ============================================================
-- WEB TỔ TOÁN — ĐĂNG NHẬP GIÁO VIÊN + CHẤM PHIẾU TÔ Ô
-- Chạy toàn bộ file này trong Supabase (project MỚI của tổ) → SQL Editor → Run.
-- Chạy lại nhiều lần vẫn an toàn.
-- ============================================================

-- (dùng gen_random_uuid() có sẵn trong Postgres, không cần extension)

-- ---------- 1. TÀI KHOẢN GIÁO VIÊN ----------
create table if not exists teachers (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  approved boolean not null default false,   -- quản trị viên duyệt mới dùng được
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

-- EMAIL QUẢN TRỊ VIÊN: tài khoản đăng ký bằng các email này tự là quản trị viên và được duyệt sẵn.
-- Muốn đổi: sửa danh sách trong ngoặc rồi chạy lại file.
create or replace function admin_emails() returns text[] language sql immutable as $$
  select array['uyentho2023@gmail.com', 'nobixu0509@gmail.com']
$$;

-- Tự tạo dòng giáo viên khi có người đăng ký
create or replace function handle_new_teacher() returns trigger
language plpgsql security definer set search_path = public as $$
declare adm boolean := lower(new.email) = any (admin_emails());
begin
  insert into teachers (id, full_name, email, approved, is_admin)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), coalesce(new.email, ''), adm, adm)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created_teacher on auth.users;
create trigger on_auth_user_created_teacher after insert on auth.users
  for each row execute function handle_new_teacher();

-- Tài khoản đã đăng ký trước khi chạy file này (nếu có)
insert into teachers (id, full_name, email, approved, is_admin)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', ''), coalesce(u.email, ''),
       lower(u.email) = any (admin_emails()), lower(u.email) = any (admin_emails())
from auth.users u
on conflict (id) do nothing;
update teachers set approved = true, is_admin = true where lower(email) = any (admin_emails());

create or replace function is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved from teachers where id = auth.uid()), false)
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and approved from teachers where id = auth.uid()), false)
$$;

alter table teachers enable row level security;
drop policy if exists teachers_select on teachers;
create policy teachers_select on teachers for select using (id = auth.uid() or is_admin());
drop policy if exists teachers_admin_update on teachers;
create policy teachers_admin_update on teachers for update using (is_admin()) with check (is_admin());
drop policy if exists teachers_admin_delete on teachers;
create policy teachers_admin_delete on teachers for delete using (is_admin() and id <> auth.uid());

-- ---------- 2. LỚP + DANH SÁCH HỌC SINH (để khớp họ tên trên phiếu lớp) ----------
create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references teachers(id) on delete cascade,
  class_name text not null,
  created_at timestamptz default now()
);

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id) on delete cascade,
  teacher_id uuid not null default auth.uid() references teachers(id) on delete cascade,
  stt int,
  full_name text not null,
  student_code text,
  created_at timestamptz default now()
);
create index if not exists idx_students_class on students(class_id, stt);

-- ---------- 3. CHẤM PHIẾU ----------
create table if not exists paper_batches (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references teachers(id) on delete cascade,
  class_id uuid references classes(id) on delete set null,
  title text not null,
  config jsonb not null,          -- { n1, n2, n3, p1, p2, p3, tfMethod, sheet: 'school'|'class'|'grid35', identity: 'phach'|'name', paper: 'A4'|'A5' }
  created_at timestamptz default now()
);

create table if not exists paper_keys (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references paper_batches(id) on delete cascade,
  teacher_id uuid not null default auth.uid() references teachers(id) on delete cascade,
  ma_de text not null,
  answers jsonb not null,         -- { p1: ['A',...], p2: [[true,false,..],...], p3: ['-1',...] }
  created_at timestamptz default now(),
  unique (batch_id, ma_de)
);

create table if not exists paper_sheets (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references paper_batches(id) on delete cascade,
  teacher_id uuid not null default auth.uid() references teachers(id) on delete cascade,
  student_id uuid references students(id) on delete set null,
  student_name text not null default '',
  name_read text,
  class_label text,
  ma_de text not null,
  answers jsonb not null,
  score numeric not null,
  part_scores jsonb not null,
  edited_cells jsonb not null default '[]'::jsonb,
  ai_model text,
  ma_phach text,
  so_phach text,
  stt text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Bản cập nhật: lưu mã file ảnh phiếu trong Google Drive của giáo viên (KHÔNG ảnh hưởng các phiếu đã chấm)
alter table paper_sheets add column if not exists image_drive_id text;
alter table paper_sheets add column if not exists overlay_drive_id text;

create index if not exists idx_paper_batches_teacher on paper_batches(teacher_id, created_at desc);
create index if not exists idx_paper_keys_batch on paper_keys(batch_id);
create index if not exists idx_paper_sheets_batch on paper_sheets(batch_id);
create index if not exists idx_paper_sheets_phach on paper_sheets(batch_id, ma_phach, so_phach);
create unique index if not exists uq_paper_sheets_student on paper_sheets(batch_id, student_id) where student_id is not null;

-- ---------- 4. PHÂN QUYỀN: chỉ giáo viên ĐÃ ĐƯỢC DUYỆT, chỉ dữ liệu của chính mình ----------
alter table classes enable row level security;
alter table students enable row level security;
alter table paper_batches enable row level security;
alter table paper_keys enable row level security;
alter table paper_sheets enable row level security;

drop policy if exists own_classes on classes;
create policy own_classes on classes for all
  using (teacher_id = auth.uid() and is_approved())
  with check (teacher_id = auth.uid() and is_approved());

drop policy if exists own_students on students;
create policy own_students on students for all
  using (teacher_id = auth.uid() and is_approved())
  with check (teacher_id = auth.uid() and is_approved()
    and exists (select 1 from classes c where c.id = class_id and c.teacher_id = auth.uid()));

drop policy if exists own_paper_batches on paper_batches;
create policy own_paper_batches on paper_batches for all
  using (teacher_id = auth.uid() and is_approved())
  with check (teacher_id = auth.uid() and is_approved()
    and (class_id is null or exists (select 1 from classes c where c.id = class_id and c.teacher_id = auth.uid())));

drop policy if exists own_paper_keys on paper_keys;
create policy own_paper_keys on paper_keys for all
  using (teacher_id = auth.uid() and is_approved())
  with check (teacher_id = auth.uid() and is_approved()
    and exists (select 1 from paper_batches b where b.id = batch_id and b.teacher_id = auth.uid()));

drop policy if exists own_paper_sheets on paper_sheets;
create policy own_paper_sheets on paper_sheets for all
  using (teacher_id = auth.uid() and is_approved())
  with check (teacher_id = auth.uid() and is_approved()
    and exists (select 1 from paper_batches b where b.id = batch_id and b.teacher_id = auth.uid()));

-- ---------- 5. QUYỀN TRUY CẬP API (phòng khi project tắt "tự cấp quyền cho bảng mới") ----------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on teachers, classes, students, paper_batches, paper_keys, paper_sheets to authenticated;
grant execute on function is_approved(), is_admin() to authenticated;
