import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getUserByUsername, createSession } from '@/lib/db'
import { SESSION_COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { username, password } = await req.json()
  if (!username || !password) {
    return NextResponse.json({ error: 'Missing credentials' }, { status: 400 })
  }

  const user = getUserByUsername(username)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  if (user.active === 0) {
    return NextResponse.json(
      { error: user.restricted_msg ?? 'Account access restricted. Please contact support.' },
      { status: 403 }
    )
  }

  const sessionId = createSession(user.id)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  return res
}
