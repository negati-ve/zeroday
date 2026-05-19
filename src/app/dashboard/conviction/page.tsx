import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import ConvictionClient from './ConvictionClient'

export default async function ConvictionPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  return <ConvictionClient />
}
