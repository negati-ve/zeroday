import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import LiveClient from './LiveClient'

export default async function LivePage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  return <LiveClient />
}
