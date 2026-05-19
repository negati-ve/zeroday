import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getDb } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = getDb().prepare(
    'SELECT id, name, config_json, last_run_summary, last_run_at, config_hash, created_at, updated_at FROM strategies WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(user.userId) as any[]

  return NextResponse.json(rows.map(r => ({
    id: r.id, name: r.name, config: JSON.parse(r.config_json),
    lastResults: r.last_run_summary ? JSON.parse(r.last_run_summary) : null,
    lastRunAt: r.last_run_at, configHash: r.config_hash,
    createdAt: r.created_at, updatedAt: r.updated_at,
  })))
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { name, config, results, configHash } = body
  if (!name || !config) return NextResponse.json({ error: 'name and config required' }, { status: 400 })

  const configJson = JSON.stringify(config)
  const resultsJson = results ? JSON.stringify(results) : null

  try {
    // If configHash provided, try to find and update existing strategy with same hash
    if (configHash) {
      const existing = getDb().prepare(
        'SELECT id FROM strategies WHERE user_id = ? AND config_hash = ?'
      ).get(user.userId, configHash) as any
      if (existing) {
        getDb().prepare(
          'UPDATE strategies SET config_json = ?, last_run_summary = ?, last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
        ).run(configJson, resultsJson, existing.id)
        const row = getDb().prepare(
          'SELECT id, name, config_json, last_run_summary, last_run_at, config_hash, created_at, updated_at FROM strategies WHERE id = ?'
        ).get(existing.id) as any
        return NextResponse.json({
          id: row.id, name: row.name, config: JSON.parse(row.config_json),
          lastResults: row.last_run_summary ? JSON.parse(row.last_run_summary) : null,
          lastRunAt: row.last_run_at, configHash: row.config_hash,
          createdAt: row.created_at, updatedAt: row.updated_at,
        })
      }
    }

    getDb().prepare(
      'INSERT INTO strategies (user_id, name, config_json, last_run_summary, last_run_at, config_hash) VALUES (?, ?, ?, ?, unixepoch(), ?)'
    ).run(user.userId, name, configJson, resultsJson, configHash ?? null)

    const row = getDb().prepare(
      'SELECT id, name, config_json, last_run_summary, last_run_at, config_hash, created_at, updated_at FROM strategies WHERE user_id = ? AND name = ?'
    ).get(user.userId, name) as any

    return NextResponse.json({
      id: row.id, name: row.name, config: JSON.parse(row.config_json),
      lastResults: row.last_run_summary ? JSON.parse(row.last_run_summary) : null,
      lastRunAt: row.last_run_at, configHash: row.config_hash,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      // Name conflict — update existing
      const existing = getDb().prepare(
        'SELECT id FROM strategies WHERE user_id = ? AND name = ?'
      ).get(user.userId, name) as any
      if (existing) {
        getDb().prepare(
          'UPDATE strategies SET config_json = ?, last_run_summary = ?, last_run_at = unixepoch(), config_hash = ?, updated_at = unixepoch() WHERE id = ?'
        ).run(configJson, resultsJson, configHash ?? null, existing.id)
        return NextResponse.json({ id: existing.id, name, config, lastResults: results, updated: true })
      }
      return NextResponse.json({ error: `Strategy "${name}" already exists` }, { status: 409 })
    }
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { id, name, config, results } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const existing = getDb().prepare(
    'SELECT id FROM strategies WHERE id = ? AND user_id = ?'
  ).get(id, user.userId) as any
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (name) getDb().prepare('UPDATE strategies SET name = ?, updated_at = unixepoch() WHERE id = ?').run(name, id)
  if (config) getDb().prepare('UPDATE strategies SET config_json = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(config), id)
  if (results) getDb().prepare('UPDATE strategies SET last_run_summary = ?, last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(results), id)

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const existing = getDb().prepare(
    'SELECT id FROM strategies WHERE id = ? AND user_id = ?'
  ).get(id, user.userId) as any
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Cascade delete
  const liveIds = getDb().prepare('SELECT id FROM live_strategies WHERE strategy_id = ?').all(id) as any[]
  for (const ls of liveIds) {
    getDb().prepare('DELETE FROM paper_positions WHERE live_strategy_id = ?').run(ls.id)
  }
  getDb().prepare('DELETE FROM live_strategies WHERE strategy_id = ?').run(id)
  getDb().prepare('DELETE FROM strategies WHERE id = ?').run(id)

  return NextResponse.json({ ok: true })
}
