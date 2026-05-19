import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import LoginClient from './LoginClient'

export default async function RootPage() {
  const user = await getSessionUser()
  if (user) redirect('/dashboard')
  return <LoginClient />
}
