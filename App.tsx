import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { Session } from '@supabase/supabase-js'
import * as ExpoLinking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from './lib/supabase'

WebBrowser.maybeCompleteAuthSession()

type Product = {
  id: string
  name: string
  category: string
  price: number
  emoji: string | null
  unit: string
}

type CartRow = { product_id: string; quantity: number }
type Cart = Record<string, number>

const money = (value: number) => `₦${new Intl.NumberFormat('en-NG').format(value)}`

function normalizeCart(items: unknown): Cart {
  if (!Array.isArray(items)) return {}
  return Object.fromEntries(
    items
      .filter((item): item is CartRow => Boolean(item && typeof item === 'object'))
      .map(item => [String(item.product_id), Math.floor(Number(item.quantity))] as const)
      .filter(([id, quantity]) => Boolean(id) && Number.isFinite(quantity) && quantity > 0 && quantity <= 99),
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checkingLogin, setCheckingLogin] = useState(true)
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Cart>({})
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [cartMessage, setCartMessage] = useState('Connecting to your basket…')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) Alert.alert('Sign-in check failed', error.message)
      setSession(data.session)
      setCheckingLogin(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let live = true
    supabase.from('products')
      .select('id,name,category,price,emoji,unit')
      .eq('active', true)
      .order('name')
      .then(({ data, error }) => {
        if (!live) return
        if (error) Alert.alert('Could not load products', error.message)
        setProducts((data ?? []) as Product[])
        setLoadingProducts(false)
      })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) {
      setCart({})
      setCartMessage('Sign in to load your shared basket.')
      return
    }
    let live = true
    const channel = supabase.channel(`mobile-basket-${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'shopping_carts', filter: `user_id=eq.${userId}`,
      }, payload => {
        const next = (payload.new as { items?: unknown } | undefined)?.items
        if (live && next !== undefined) {
          setCart(normalizeCart(next))
          setCartMessage('Synced with your website basket.')
        }
      })
      .subscribe()

    async function loadCart() {
      const { data, error } = await supabase.from('shopping_carts')
        .select('items').eq('user_id', userId).maybeSingle()
      if (!live) return
      if (error) {
        console.error('Could not load shared basket:', error)
        setCartMessage('Basket setup is needed. Ask the project owner to run shared-cart.sql in Supabase.')
        return
      }
      setCart(normalizeCart(data?.items))
      setCartMessage('Synced with your website basket.')
    }
    void loadCart()
    return () => {
      live = false
      void supabase.removeChannel(channel)
    }
  }, [session?.user.id])

  const cartProducts = useMemo(() => products
    .filter(product => (cart[product.id] ?? 0) > 0)
    .map(product => ({ product, quantity: cart[product.id] })), [products, cart])
  const itemCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0)
  const total = cartProducts.reduce((sum, row) => sum + row.product.price * row.quantity, 0)

  async function signIn() {
    setBusy(true)
    try {
      const redirectTo = ExpoLinking.createURL('auth/callback')
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      })
      if (error) throw error
      if (!data.url) throw new Error('Supabase did not return a Google sign-in link.')
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
      if (result.type !== 'success') return
      const callback = new URL(result.url)
      const code = callback.searchParams.get('code')
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        if (exchangeError) throw exchangeError
      } else {
        const params = new URLSearchParams(callback.hash.replace(/^#/, ''))
        const access_token = params.get('access_token')
        const refresh_token = params.get('refresh_token')
        if (!access_token || !refresh_token) throw new Error('Sign-in returned no session. Please try again.')
        const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token })
        if (sessionError) throw sessionError
      }
    } catch (error) {
      Alert.alert('Google sign-in failed', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function saveCart(next: Cart) {
    if (!session?.user.id) return
    setCart(next)
    setCartMessage('Saving basket…')
    const items = Object.entries(next).map(([product_id, quantity]) => ({ product_id, quantity }))
    const { error } = await supabase.from('shopping_carts').upsert({
      user_id: session.user.id,
      items,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (error) {
      console.error('Could not save shared basket:', error)
      setCartMessage('Could not save. Check the internet and try again.')
      Alert.alert('Basket did not save', error.message)
    } else {
      setCartMessage('Synced with your website basket.')
    }
  }

  function changeQuantity(productId: string, difference: number) {
    const next = { ...cart }
    const quantity = (next[productId] ?? 0) + difference
    if (quantity <= 0) delete next[productId]
    else next[productId] = Math.min(quantity, 99)
    void saveCart(next)
  }

  if (checkingLogin) return <View style={styles.center}><ActivityIndicator size="large" color="#34472f" /></View>

  if (!session) {
    return (
      <View style={styles.loginScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.brandMark}><Text style={styles.markText}>✿</Text></View>
        <Text style={styles.eyebrow}>YOUR NEIGHBOURHOOD PROVISIONS</Text>
        <Text style={styles.title}>Good Basket</Text>
        <Text style={styles.loginCopy}>Sign in with the same Google account you use on the shop website. Your basket will follow you.</Text>
        <Pressable style={[styles.primaryButton, busy && styles.disabled]} onPress={signIn} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue with Google</Text>}
        </Pressable>
        <Text style={styles.smallHint}>If Google doesn’t return to the app, the mobile sign-in link still needs to be added in Supabase.</Text>
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR EVERYDAY SHOP</Text>
          <Text style={styles.headerTitle}>Good Basket</Text>
          <Text style={styles.email} numberOfLines={1}>{session.user.email}</Text>
        </View>
        <Pressable onPress={() => void supabase.auth.signOut()}><Text style={styles.signOut}>Sign out</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.syncCard}>
          <View style={styles.syncDot} />
          <View style={styles.syncTextWrap}>
            <Text style={styles.syncTitle}>Your basket</Text>
            <Text style={styles.syncMessage}>{cartMessage}</Text>
          </View>
          <Text style={styles.itemCount}>{itemCount}</Text>
        </View>

        <Text style={styles.sectionTitle}>Your basket</Text>
        {cartProducts.length === 0 ? (
          <View style={styles.emptyCard}><Text style={styles.emptyTitle}>Your basket is empty</Text><Text style={styles.muted}>Add something from the shelves below. Website basket changes will show here too.</Text></View>
        ) : cartProducts.map(({ product, quantity }) => (
          <View key={product.id} style={styles.basketRow}>
            <Text style={styles.productEmoji}>{product.emoji || '🛍️'}</Text>
            <View style={styles.productCopy}>
              <Text style={styles.productName}>{product.name}</Text>
              <Text style={styles.muted}>{money(product.price)} / {product.unit}</Text>
            </View>
            <View style={styles.quantityControl}>
              <Pressable style={styles.quantityButton} onPress={() => changeQuantity(product.id, -1)}><Text style={styles.quantityText}>−</Text></Pressable>
              <Text style={styles.quantity}>{quantity}</Text>
              <Pressable style={styles.quantityButton} onPress={() => changeQuantity(product.id, 1)}><Text style={styles.quantityText}>+</Text></Pressable>
            </View>
          </View>
        ))}

        <View style={styles.shelfHeading}>
          <Text style={styles.sectionTitle}>The kiosk shelves</Text>
          {loadingProducts && <ActivityIndicator color="#718151" />}
        </View>
        {products.map(product => (
          <View key={product.id} style={styles.productCard}>
            <Text style={styles.productEmoji}>{product.emoji || '🛍️'}</Text>
            <View style={styles.productCopy}>
              <Text style={styles.category}>{product.category}</Text>
              <Text style={styles.productName}>{product.name}</Text>
              <Text style={styles.muted}>{money(product.price)} / {product.unit}</Text>
            </View>
            <Pressable style={styles.addButton} onPress={() => changeQuantity(product.id, 1)}><Text style={styles.addText}>+</Text></Pressable>
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.footerLabel}>Basket total · {itemCount} item{itemCount === 1 ? '' : 's'}</Text>
        <Text style={styles.footerTotal}>{money(total)}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8f6ef' },
  loginScreen: { flex: 1, backgroundColor: '#f8f6ef', alignItems: 'center', justifyContent: 'center', padding: 28 },
  brandMark: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#dce7a1', alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  markText: { color: '#34472f', fontSize: 32 },
  eyebrow: { color: '#718151', fontSize: 10, fontWeight: '700', letterSpacing: 1.7 },
  title: { color: '#252c20', fontSize: 38, fontWeight: '700', marginTop: 10 },
  loginCopy: { color: '#74786e', fontSize: 15, lineHeight: 23, textAlign: 'center', maxWidth: 320, marginTop: 14, marginBottom: 25 },
  primaryButton: { backgroundColor: '#34472f', borderRadius: 7, minHeight: 52, width: '100%', alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.7 },
  smallHint: { color: '#8b5735', fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 18, maxWidth: 330 },
  screen: { flex: 1, backgroundColor: '#f8f6ef' },
  header: { paddingTop: 54, paddingHorizontal: 20, paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: '#e5e1d6', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { color: '#252c20', fontSize: 28, fontWeight: '700', marginTop: 4 },
  email: { color: '#74786e', fontSize: 12, marginTop: 3, maxWidth: 250 },
  signOut: { color: '#34472f', fontSize: 13, fontWeight: '700', padding: 8 },
  content: { padding: 18, paddingBottom: 30 },
  syncCard: { backgroundColor: '#e8eadb', padding: 14, borderRadius: 8, flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  syncDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#4c9b70', marginRight: 10 },
  syncTextWrap: { flex: 1 },
  syncTitle: { color: '#252c20', fontWeight: '700', fontSize: 14 },
  syncMessage: { color: '#65695f', fontSize: 11, marginTop: 3 },
  itemCount: { color: '#34472f', fontWeight: '700', fontSize: 18, paddingHorizontal: 8 },
  sectionTitle: { color: '#252c20', fontSize: 21, fontWeight: '700', marginBottom: 12 },
  emptyCard: { backgroundColor: '#fffefa', borderColor: '#e5e1d6', borderWidth: 1, padding: 17, borderRadius: 8, marginBottom: 24 },
  emptyTitle: { color: '#252c20', fontWeight: '700', fontSize: 15, marginBottom: 5 },
  muted: { color: '#74786e', fontSize: 12, lineHeight: 18 },
  basketRow: { backgroundColor: '#fffefa', borderColor: '#e5e1d6', borderWidth: 1, borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  productEmoji: { fontSize: 30, width: 45, textAlign: 'center' },
  productCopy: { flex: 1, paddingHorizontal: 8 },
  productName: { color: '#252c20', fontWeight: '700', fontSize: 14, marginBottom: 3 },
  quantityControl: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  quantityButton: { height: 30, width: 30, borderRadius: 15, backgroundColor: '#dce7a1', alignItems: 'center', justifyContent: 'center' },
  quantityText: { color: '#34472f', fontWeight: '700', fontSize: 18 },
  quantity: { color: '#252c20', fontWeight: '700', minWidth: 15, textAlign: 'center' },
  shelfHeading: { marginTop: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  productCard: { backgroundColor: '#fffefa', borderColor: '#e5e1d6', borderWidth: 1, borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center', marginBottom: 9 },
  category: { color: '#718151', fontSize: 9, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 3 },
  addButton: { backgroundColor: '#dce7a1', height: 36, width: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#34472f', fontSize: 23, fontWeight: '500' },
  footer: { backgroundColor: '#fffefa', borderTopColor: '#e5e1d6', borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLabel: { color: '#74786e', fontSize: 13 },
  footerTotal: { color: '#252c20', fontWeight: '700', fontSize: 18 },
})
