'use client'
import { useEffect, useState } from 'react'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const stored = localStorage.getItem('zd-theme') as 'dark' | 'light' | null
    if (stored) setTheme(stored)
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('zd-theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  return (
    <button onClick={toggle} style={{
      background: 'var(--bg3)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      padding: '4px 10px',
      color: 'var(--text2)',
      fontSize: '11px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      letterSpacing: '0.05em',
    }}>
      {theme === 'dark' ? '○ LIGHT' : '● DARK'}
    </button>
  )
}
