import { useEffect, useRef, useState } from 'react'
import {
  DatabaseBackup,
  Download,
  FileJson,
  Loader2,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import CustomSelect from './CustomSelect'
import { api, downloadApi } from '../lib/api'

interface BackupCenterProps {
  open: boolean
  onClose: () => void
  /** Whole-system backup is owner/admin only; the worker enforces it too. */
  isAdmin: boolean
}

interface UserRestoreResult {
  deployments_added: number
  deployments_skipped: number
  tokens_added: number
  tokens_skipped: number
  members_added: number
  members_skipped: number
  injectors_added: number
  injectors_skipped: number
  groups_added: number
  groups_skipped: number
}

interface SystemRestoreResult {
  tables: number
  rows: number
}

type Busy = null | 'export' | 'import'

const today = () => new Date().toISOString().slice(0, 10)

export default function BackupCenter({ open, onClose, isAdmin }: BackupCenterProps) {
  const [userBusy, setUserBusy] = useState<Busy>(null)
  const [systemBusy, setSystemBusy] = useState<Busy>(null)
  const [userFile, setUserFile] = useState<File | null>(null)
  const [systemFile, setSystemFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const userInput = useRef<HTMLInputElement>(null)
  const systemInput = useRef<HTMLInputElement>(null)

  // Esc closes the dialog, like every other modal in the panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const exportUser = async () => {
    setUserBusy('export')
    setMsg(null)
    try {
      await downloadApi('/backup', `miliconfig-backup-${today()}.json`)
      setMsg({ text: 'بکاپ اطلاعات شما دانلود شد.', ok: true })
    } catch (e) {
      setMsg({ text: `خطا در تهیه خروجی: ${e instanceof Error ? e.message : 'دانلود ناموفق بود'}`, ok: false })
    } finally {
      setUserBusy(null)
    }
  }

  const importUser = async () => {
    if (!userFile) { setMsg({ text: 'اول فایل بکاپ را انتخاب کنید.', ok: false }); return }
    setUserBusy('import')
    setMsg(null)
    try {
      const parsed = JSON.parse(await userFile.text()) as Record<string, unknown>
      const res = await api<UserRestoreResult>('/backup', { method: 'POST', body: { ...parsed, mode } })
      const skipped = res.deployments_skipped + res.tokens_skipped + res.members_skipped + res.injectors_skipped + res.groups_skipped
      setMsg({
        text: `بازیابی انجام شد: ${res.deployments_added} ورکر/پنل، ${res.tokens_added} توکن، ${res.members_added} کاربر ورکر و ${res.groups_added} گروه ساب و ${res.injectors_added} ساب تزریقی بازیابی شدند${skipped ? ` (${skipped} مورد تکراری رد شد)` : ''}.`,
        ok: true,
      })
      setUserFile(null)
      if (userInput.current) userInput.current.value = ''
    } catch (e) {
      setMsg({ text: `خطا در بازگردانی: ${e instanceof Error ? e.message : 'فایل نامعتبر است'}`, ok: false })
    } finally {
      setUserBusy(null)
    }
  }

  const exportSystem = async () => {
    setSystemBusy('export')
    setMsg(null)
    try {
      await downloadApi('/backup/system', `miliconfig-system-backup-${today()}.json`)
      setMsg({ text: 'بکاپ جامع سیستم دانلود شد.', ok: true })
    } catch (e) {
      setMsg({ text: `خطا در تهیه خروجی جامع: ${e instanceof Error ? e.message : 'دانلود ناموفق بود'}`, ok: false })
    } finally {
      setSystemBusy(null)
    }
  }

  const importSystem = async () => {
    if (!systemFile) { setMsg({ text: 'اول فایل بکاپ جامع را انتخاب کنید.', ok: false }); return }
    if (!window.confirm('تمام جدول‌های دیتابیس با محتوای این فایل جایگزین می‌شوند. ادامه می‌دهید؟')) return
    setSystemBusy('import')
    setMsg(null)
    try {
      const parsed = JSON.parse(await systemFile.text()) as Record<string, unknown>
      const res = await api<SystemRestoreResult>('/backup/system', { method: 'POST', body: { ...parsed, mode: 'replace' } })
      setMsg({ text: `بازیابی کل سیستم انجام شد: ${res.rows.toLocaleString()} ردیف در ${res.tables} جدول بازگردانی شد.`, ok: true })
      setSystemFile(null)
      if (systemInput.current) systemInput.current.value = ''
    } catch (e) {
      setMsg({ text: `خطا در بازیابی سیستم: ${e instanceof Error ? e.message : 'فایل نامعتبر است'}`, ok: false })
    } finally {
      setSystemBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-3 sm:p-6" dir="rtl">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="مرکز بکاپ و بازیابی اطلاعات"
        className="relative w-full max-w-2xl my-4 rounded-3xl border shadow-2xl animate-fade-in"
        style={{ background: 'var(--t-bg2)', borderColor: 'var(--t-line-strong)' }}
      >
        {/* header */}
        <div className="flex items-start gap-3 p-5 border-b" style={{ borderColor: 'var(--t-line)' }}>
          <button
            onClick={onClose}
            aria-label="بستن"
            className="shrink-0 w-9 h-9 rounded-full border flex items-center justify-center text-slate-300 hover:text-white transition-colors"
            style={{ borderColor: 'var(--t-line-strong)' }}
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0 text-center">
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center justify-center gap-2">
              <DatabaseBackup className="w-5 h-5 text-brand-400" />
              مرکز بکاپ و بازیابی اطلاعات
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-400 mt-1">پشتیبان‌گیری و بازیابی آتی برای کاربران و ادمین</p>
          </div>
          <div className="shrink-0 w-9 h-9 rounded-full border flex items-center justify-center text-brand-400" style={{ borderColor: 'var(--t-line-strong)' }}>
            <DatabaseBackup className="w-4 h-4" />
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {msg && (
            <div
              className={`rounded-xl border px-3 py-2.5 text-xs leading-6 ${
                msg.ok ? 'text-brand-300 border-brand-400/30 bg-brand-400/10' : 'text-error-400 border-error-400/30 bg-error-400/10'
              }`}
            >
              {msg.text}
            </div>
          )}

          {/* ── 1. user backup ── */}
          <section className="rounded-2xl border p-4" style={{ borderColor: 'var(--t-line-strong)', background: 'rgba(255,255,255,0.02)' }}>
            <h3 className="text-sm font-bold text-white">۱. بکاپ کامل اطلاعات من (ویژه کاربر)</h3>
            <p className="text-[11px] sm:text-xs text-slate-400 mt-1.5 leading-6">
              شامل تمام ورکرها و پنل‌های مستقرشده، لینک‌های ساب، توکن‌های کلادفلر، کاربران ورکر، گروه‌های ساب و تزریق‌کننده‌ها
            </p>

            <button
              onClick={() => void exportUser()}
              disabled={userBusy !== null}
              className="btn-primary w-full mt-3 flex items-center justify-center gap-2 text-sm disabled:opacity-60"
            >
              {userBusy === 'export' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              دانلود بکاپ من (JSON)
            </button>

            <div className="flex items-center gap-3 my-4">
              <span className="flex-1 h-px" style={{ background: 'var(--t-line)' }} />
              <span className="text-[11px] text-slate-500">بازیابی اطلاعات من از فایل بکاپ:</span>
              <span className="flex-1 h-px" style={{ background: 'var(--t-line)' }} />
            </div>

            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-xs text-slate-400">
                {userFile ? userFile.name : 'فایلی انتخاب نشده است'}
              </span>
              <button
                onClick={() => userInput.current?.click()}
                className="btn-secondary shrink-0 flex items-center gap-1.5 text-xs px-3 py-2"
              >
                <FileJson className="w-3.5 h-3.5" /> انتخاب فایل
              </button>
              <input
                ref={userInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => { setUserFile(e.target.files?.[0] ?? null); setMsg(null) }}
              />
            </div>

            <CustomSelect
              value={mode}
              onChange={(e) => setMode(e.target.value === 'replace' ? 'replace' : 'merge')}
              className="input-field w-full mt-2 text-sm"
            >
              <option value="merge">ادغام با داده‌های فعلی</option>
              <option value="replace">جایگزینی کاربران، گروه‌ها و ساب‌های تزریقی</option>
            </CustomSelect>

            <button
              onClick={() => void importUser()}
              disabled={userBusy !== null || !userFile}
              className="btn-secondary w-full mt-2 flex items-center justify-center gap-2 text-sm disabled:opacity-50"
            >
              {userBusy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              بازیابی بکاپ
            </button>
          </section>

          {/* ── 2. admin whole-system backup ── */}
          {isAdmin && (
            <section className="rounded-2xl border p-4" style={{ borderColor: 'var(--t-line-strong)', background: 'rgba(255,255,255,0.02)' }}>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-brand-400" />
                ۲. بکاپ جامع کل سیستم (ویژه ادمین)
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-400 mt-1.5 leading-6">
                شامل تمامی کاربران وب و ربات تلگرام، تمام ورکرها و پنل‌ها، توکن‌ها، تنظیمات ربات تلگرام و کل جدول‌های دیتابیس D1
              </p>

              <button
                onClick={() => void exportSystem()}
                disabled={systemBusy !== null}
                className="btn-primary w-full mt-3 flex items-center justify-center gap-2 text-sm disabled:opacity-60"
              >
                {systemBusy === 'export' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                دانلود بکاپ کامل ادمین (JSON)
              </button>

              <div className="flex items-center gap-3 my-4">
                <span className="flex-1 h-px" style={{ background: 'var(--t-line)' }} />
                <span className="text-[11px] text-slate-500">بازیابی کل دیتابیس از فایل بکاپ ادمین:</span>
                <span className="flex-1 h-px" style={{ background: 'var(--t-line)' }} />
              </div>

              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-xs text-slate-400">
                  {systemFile ? systemFile.name : 'فایلی انتخاب نشده است'}
                </span>
                <button
                  onClick={() => systemInput.current?.click()}
                  className="btn-secondary shrink-0 flex items-center gap-1.5 text-xs px-3 py-2"
                >
                  <FileJson className="w-3.5 h-3.5" /> انتخاب فایل
                </button>
                <input
                  ref={systemInput}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => { setSystemFile(e.target.files?.[0] ?? null); setMsg(null) }}
                />
              </div>

              <button
                onClick={() => void importSystem()}
                disabled={systemBusy !== null || !systemFile}
                className="btn-secondary w-full mt-2 flex items-center justify-center gap-2 text-sm disabled:opacity-50"
              >
                {systemBusy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                بازیابی کل سیستم
              </button>

              <p className="text-[11px] text-error-400/90 mt-2 leading-5">
                بازیابی جامع، تمام جدول‌های دیتابیس را با محتوای فایل جایگزین می‌کند. قبل از ادامه یک بکاپ تازه بگیرید.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
