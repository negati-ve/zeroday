import { getSessionUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import CrudeConvictionClient from './CrudeConvictionClient'

export default async function CrudeConvictionPage() {
  const user = await getSessionUser()
  if (!user) redirect('/')
  return <CrudeConvictionClient role={user.role} />
}
