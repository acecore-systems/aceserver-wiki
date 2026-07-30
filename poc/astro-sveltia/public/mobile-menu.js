;(() => {
  const desktopMedia = window.matchMedia('(min-width: 67.5rem)')
  const main = document.querySelector('.main')

  for (const menu of document.querySelectorAll('.mobile-menu')) {
    if (!(menu instanceof HTMLDetailsElement)) continue

    const summary = menu.querySelector('summary')

    const updateMenuState = () => {
      const isModal = menu.open && !desktopMedia.matches
      document.body.classList.toggle('has-open-mobile-menu', isModal)

      if (isModal) {
        main?.setAttribute('inert', '')
      } else {
        main?.removeAttribute('inert')
      }
    }

    const closeMenu = () => {
      menu.open = false
      updateMenuState()
    }

    menu.addEventListener('toggle', updateMenuState)
    menu.addEventListener('click', (event) => {
      if (event.target instanceof HTMLAnchorElement) closeMenu()
    })
    menu.addEventListener('keydown', (event) => {
      if (!menu.open) return

      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        summary?.focus()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = Array.from(
        menu.querySelectorAll(
          'summary, a[href], input:not([disabled]), button:not([disabled])',
        ),
      ).filter((element) => element.getClientRects().length > 0)
      const first = focusable.at(0)
      const last = focusable.at(-1)

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    })

    desktopMedia.addEventListener('change', ({ matches }) => {
      if (matches) {
        closeMenu()
      } else {
        updateMenuState()
      }
    })

    if (desktopMedia.matches) {
      closeMenu()
    } else {
      updateMenuState()
    }
  }
})()
