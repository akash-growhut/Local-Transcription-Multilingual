import './main.css'
import './theme.css'
import './styles.css'
import Modal from 'react-modal'
import App from './App'

Modal.setAppElement('#root')

export default function AppWrapper() {
  return <App />
}
