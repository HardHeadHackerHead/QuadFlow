// DEV ONLY entry for /ui-gallery (see ui-gallery.html). Not imported by the app.
import ReactDOM from 'react-dom/client'
import '../../index.css'
import UiGallery from './UiGallery'

if (!import.meta.env.DEV) {
  throw new Error('/ui-gallery is a dev-only page')
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<UiGallery />)
