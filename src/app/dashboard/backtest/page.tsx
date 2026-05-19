import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import BacktestClient from './BacktestClient'

export default async function BacktestPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  return <BacktestClient />
}
