import { getSessionUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import BitcoinConvictionClient from './BitcoinConvictionClient'

export default async function BitcoinConvictionPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  if (user.role !== 'admin') redirect('/dashboard')
  return <BitcoinConvictionClient role={user.role} />
}
