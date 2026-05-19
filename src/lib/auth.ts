import { cookies } from 'next/headers'
import { getSession } from './db'

export const SESSION_COOKIE = 'zd_session'

export async function getSessionUser(): Promise<{ userId: number } | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = getSession(token)
  if (!session) return null
  return { userId: session.user_id }
}
