import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import DashboardClient from './DashboardClient'

export default async function DashboardPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  return <DashboardClient role={user.role} />
}
