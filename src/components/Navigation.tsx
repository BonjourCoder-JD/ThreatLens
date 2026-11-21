/**
 * Sidebar navigation — royal-blue chrome per the ThreatLens design system
 * (src/themes.css's `threatlens` theme, read through the `--color-shell`
 * token so the color lives in one place, not hardcoded here).
 *
 * Restyled from the scaffold's horizontal top bar to a vertical sidebar for
 * the Day 2 redesign, but every hook, piece of role/dev filtering logic,
 * and — critically — every `data-testid` is unchanged from the original,
 * so the existing Playwright suite (`app-navigation`, `nav-sign-in-button`,
 * `nav-user-name`, `nav-user-email`, the `Account menu` accessible name)
 * keeps passing without modification. Restyle or rebuild further freely,
 * but keep those hooks — see tests/smoke.spec.ts and tests/collab.spec.ts.
 */

import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AuthOverlay, useAuthProfileReady, signOut } from 'deepspace'
import { ChevronDown, LogOut, Menu, X, ShieldCheck, Home as HomeIcon, LayoutDashboard, Settings as SettingsIcon, UserCog, FolderOpen } from 'lucide-react'
import { APP_NAME } from '../constants'
import type { Role } from '../constants'
import { nav } from '../nav'
import { cn } from '../lib/utils'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui'

/** One icon per known nav path. Falls back to a generic dot for anything
 *  added later without an icon — never breaks, just looks a bit plainer. */
const NAV_ICONS: Record<string, typeof HomeIcon> = {
  '/home': HomeIcon,
  '/dashboard': LayoutDashboard,
  '/cases': FolderOpen,
  '/settings': SettingsIcon,
  '/admin': UserCog,
}

export default function Navigation() {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)

  const profileReady = !isSignedIn || (!userLoading && !!user)
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  const navLink = (item: (typeof nav)[number], onClick?: () => void) => {
    const active = location.pathname.startsWith(item.path)
    const Icon = NAV_ICONS[item.path]
    return (
      <Link
        key={item.path}
        to={item.path}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
          active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white',
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
        {item.label}
      </Link>
    )
  }

  const accountArea = (variant: 'sidebar' | 'mobile') => {
    if (!isLoaded) return null

    if (isSignedIn && !profileReady) {
      return (
        <div className="flex items-center gap-2 rounded-lg bg-white/10 px-2 py-1.5">
          <div className="h-7 w-7 animate-pulse rounded-full bg-white/20" />
          <div className="h-3.5 w-20 animate-pulse rounded-md bg-white/20" />
        </div>
      )
    }

    if (isSignedIn && user) {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label="Account menu"
                className={cn(
                  'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-white/10',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
                )}
              >
                <Avatar className="h-7 w-7 ring-1 ring-inset ring-white/20">
                  <AvatarImage src={user.imageUrl ?? undefined} referrerPolicy="no-referrer" />
                  <AvatarFallback className="text-[11px]">
                    {(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span
                  data-testid="nav-user-name"
                  className="max-w-[120px] truncate text-left text-white"
                >
                  {user.name || user.email}
                </span>
                <ChevronDown
                  className="ml-auto h-3.5 w-3.5 text-white/60 transition-transform duration-150 group-data-[popup-open]:rotate-180"
                  aria-hidden
                />
              </button>
            }
          />
          <DropdownMenuContent side={variant === 'sidebar' ? 'top' : 'bottom'} align="start" className="w-56">
            <DropdownMenuLabel>
              <div className="truncate font-medium text-foreground">{user.name || 'Signed in'}</div>
              <div data-testid="nav-user-email" className="truncate text-xs font-normal text-muted-foreground">
                {user.email}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }

    return (
      <button
        data-testid="nav-sign-in-button"
        onClick={() => setShowAuthModal(true)}
        className="w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        Sign in
      </button>
    )
  }

  return (
    <div data-testid="app-navigation" className="contents">
      {/* Desktop sidebar */}
      <aside className="hidden h-screen w-60 shrink-0 flex-col bg-shell md:flex" aria-label="Main navigation">
        <Link
          to="/home"
          className="flex items-center gap-2 px-5 py-5 text-base font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <ShieldCheck className="size-5 shrink-0" aria-hidden />
          {APP_NAME}
        </Link>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label="Primary">
          {visibleNav.map((item) => navLink(item))}
        </nav>

        <div className="border-t border-white/10 p-3">{accountArea('sidebar')}</div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border bg-shell px-4 py-3 md:hidden">
        <Link to="/home" className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          {APP_NAME}
        </Link>
        <button
          className="inline-flex h-8 w-8 items-center justify-center text-white/80 hover:text-white"
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-label="Toggle menu"
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="flex flex-col gap-1 border-b border-border bg-shell px-3 py-3 md:hidden">
          {visibleNav.map((item) => navLink(item, () => setMobileMenuOpen(false)))}
          <div className="mt-2 border-t border-white/10 pt-3">{accountArea('mobile')}</div>
        </div>
      )}

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </div>
  )
}
