import { getSessionUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import N50FutConvictionClient from './N50FutConvictionClient'

export default async function N50FutConvictionPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  if (user.role !== 'admin') redirect('/dashboard')
  return <N50FutConvictionClient role={user.role} />
}
