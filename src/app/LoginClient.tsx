'use client'
import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginClient() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    setLoading(false)
    if (res.ok) {
      router.push('/dashboard')
    } else {
      const data = await res.json()
      setError(data.error || 'Login failed')
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: '32px',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '11px', letterSpacing: '0.3em', color: 'var(--text3)', textTransform: 'uppercase', marginBottom: '6px' }}>
          NSE F&amp;O Intelligence
        </div>
        <div style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text)' }}>
          ZERODAY
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>
          Find market exploits early
        </div>
      </div>

      {/* Login card */}
      <form onSubmit={handleSubmit} style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '32px',
        width: '320px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}>
        <input
          type="text"
          placeholder="username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoFocus
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '10px 12px',
            color: 'var(--text)',
            fontSize: '13px',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '10px 12px',
            color: 'var(--text)',
            fontSize: '13px',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        {error && (
          <div style={{ color: 'var(--bear)', fontSize: '12px' }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{
            background: 'var(--accent)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: '4px',
            padding: '10px 12px',
            fontSize: '13px',
            fontFamily: 'inherit',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1,
            letterSpacing: '0.05em',
          }}
        >
          {loading ? 'SIGNING IN...' : 'SIGN IN'}
        </button>
      </form>
    </div>
  )
}
