import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, ScrollView, ActivityIndicator, AppState,
  Vibration, Platform, Linking,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BarCodeScanner } from 'expo-barcode-scanner';
import { KeepAwake } from 'expo-keep-awake';

// ─────────────────────────────────────────────────
//  NOME DA TASK DE BACKGROUND (deve ser único)
// ─────────────────────────────────────────────────
const TASK_GPS = 'POLONORTE_GPS_TASK';

// ─────────────────────────────────────────────────
//  DEFINIR TAREFA DE BACKGROUND
//  Executa mesmo com tela bloqueada
// ─────────────────────────────────────────────────
TaskManager.defineTask(TASK_GPS, async ({ data, error }) => {
  if (error) {
    console.error('[GPS TASK] Erro:', error.message);
    return;
  }
  if (!data?.locations?.length) return;

  const loc = data.locations[0];

  try {
    // Recuperar config salva
    const cfg = await AsyncStorage.getItem('config');
    if (!cfg) return;
    const { servidor, token } = JSON.parse(cfg);
    if (!servidor || !token) return;

    const bateria = await Battery.getBatteryLevelAsync();

    const params = new URLSearchParams({
      token,
      lat:        loc.coords.latitude.toFixed(7),
      lng:        loc.coords.longitude.toFixed(7),
      velocidade: loc.coords.speed ? (loc.coords.speed * 3.6).toFixed(1) : '0',
      precisao:   loc.coords.accuracy?.toFixed(1) ?? '',
      direcao:    loc.coords.heading?.toFixed(1) ?? '',
      altitude:   loc.coords.altitude?.toFixed(1) ?? '',
      bateria:    Math.round(bateria * 100),
    });

    await fetch(`${servidor}?action=ping`, {
      method:    'POST',
      body:      params,
      keepalive: true,
      headers:   { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    // Salvar última posição para exibição
    await AsyncStorage.setItem('ultima_pos', JSON.stringify({
      lat:       loc.coords.latitude,
      lng:       loc.coords.longitude,
      vel:       loc.coords.speed ? (loc.coords.speed * 3.6).toFixed(0) : '0',
      prec:      loc.coords.accuracy?.toFixed(0) ?? '?',
      bat:       Math.round(bateria * 100),
      hora:      new Date().toLocaleTimeString('pt-BR'),
    }));

  } catch (e) {
    console.error('[GPS TASK] Falha ao enviar:', e.message);
  }
});

// ─────────────────────────────────────────────────
//  CORES
// ─────────────────────────────────────────────────
const C = {
  bg:      '#020c18',
  card:    '#0d1a2e',
  card2:   '#0a2210',
  border:  '#1e3050',
  verde:   '#2e9e65',
  verde2:  '#1a5c3a',
  dourado: '#c8a84b',
  txt:     '#e8f0fe',
  txt2:    '#5c7099',
  erro:    '#ef4444',
};

// ─────────────────────────────────────────────────
//  COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────
export default function App() {
  const [tela, setTela]         = useState('config'); // 'config' | 'rastreando' | 'scanner'
  const [servidor, setServidor] = useState('');
  const [token, setToken]       = useState('');
  const [status, setStatus]     = useState('parado'); // 'parado' | 'iniciando' | 'ativo' | 'erro'
  const [ultimaPos, setUltimaPos] = useState(null);
  const [totalEnvios, setTotalEnvios] = useState(0);
  const [erroMsg, setErroMsg]   = useState('');
  const [temCamera, setTemCamera] = useState(false);
  const [intervalo, setIntervalo] = useState('10'); // segundos
  const intervalRef = useRef(null);
  const appState    = useRef(AppState.currentState);

  // ── Carregar config salva ──────────────────────
  useEffect(() => {
    (async () => {
      const cfg = await AsyncStorage.getItem('config');
      if (cfg) {
        const { servidor: s, token: t, intervalo: i } = JSON.parse(cfg);
        if (s) setServidor(s);
        if (t) setToken(t);
        if (i) setIntervalo(String(i));
      }
      // Verificar se já estava rastreando
      const rodando = await Location.hasStartedLocationUpdatesAsync(TASK_GPS).catch(() => false);
      if (rodando) {
        setStatus('ativo');
        setTela('rastreando');
        iniciarAtualizacaoUI();
      }
    })();
  }, []);

  // ── Detectar volta do background ──────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        atualizarPosicaoUI();
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, []);

  // ── Atualizar UI com última posição ───────────
  const atualizarPosicaoUI = useCallback(async () => {
    const raw = await AsyncStorage.getItem('ultima_pos');
    if (raw) {
      const pos = JSON.parse(raw);
      setUltimaPos(pos);
    }
    const envios = await AsyncStorage.getItem('total_envios');
    if (envios) setTotalEnvios(parseInt(envios) || 0);
  }, []);

  const iniciarAtualizacaoUI = useCallback(() => {
    atualizarPosicaoUI();
    intervalRef.current = setInterval(atualizarPosicaoUI, 3000);
  }, [atualizarPosicaoUI]);

  const pararAtualizacaoUI = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  // ── INICIAR RASTREAMENTO ───────────────────────
  const iniciarRastreamento = async () => {
    if (!servidor.trim() || !token.trim()) {
      Alert.alert('Atenção', 'Preencha o servidor e o token antes de iniciar.');
      return;
    }

    setStatus('iniciando');
    setErroMsg('');

    try {
      // Pedir permissão foreground
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') {
        setStatus('erro');
        setErroMsg('Permissão de localização negada.');
        return;
      }

      // Pedir permissão background (essencial para tela bloqueada)
      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        Alert.alert(
          'Localização em segundo plano',
          'Para rastrear com a tela bloqueada, vá em Configurações > Aplicativos > Rastreador Polonorte > Permissões > Localização > "Permitir o tempo todo".',
          [
            { text: 'Abrir configurações', onPress: () => Linking.openSettings() },
            { text: 'Continuar mesmo assim', style: 'cancel' },
          ]
        );
      }

      // Salvar config
      const secs = Math.max(5, parseInt(intervalo) || 10);
      await AsyncStorage.setItem('config', JSON.stringify({
        servidor: servidor.trim(),
        token:    token.trim(),
        intervalo: secs,
      }));
      await AsyncStorage.setItem('total_envios', '0');
      setTotalEnvios(0);

      // Parar task anterior se existir
      const rodando = await Location.hasStartedLocationUpdatesAsync(TASK_GPS).catch(() => false);
      if (rodando) await Location.stopLocationUpdatesAsync(TASK_GPS);

      // INICIAR BACKGROUND LOCATION
      await Location.startLocationUpdatesAsync(TASK_GPS, {
        accuracy:             Location.Accuracy.High,
        timeInterval:         secs * 1000,
        distanceInterval:     0,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle:   '📍 Rastreador Polonorte',
          notificationBody:    'Enviando localização em segundo plano...',
          notificationColor:   '#1a5c3a',
          killServiceOnDestroy: false,
        },
        pausesUpdatesAutomatically: false,
        activityType: Location.ActivityType.AutomotiveNavigation,
      });

      setStatus('ativo');
      setTela('rastreando');
      iniciarAtualizacaoUI();
      Vibration.vibrate(200);

    } catch (e) {
      setStatus('erro');
      setErroMsg(e.message || 'Erro desconhecido ao iniciar.');
    }
  };

  // ── PARAR RASTREAMENTO ─────────────────────────
  const pararRastreamento = async () => {
    Alert.alert(
      'Parar rastreamento?',
      'O envio de localização será interrompido.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Parar',
          style: 'destructive',
          onPress: async () => {
            try {
              const rodando = await Location.hasStartedLocationUpdatesAsync(TASK_GPS).catch(() => false);
              if (rodando) await Location.stopLocationUpdatesAsync(TASK_GPS);
            } catch (e) {}
            pararAtualizacaoUI();
            setStatus('parado');
            setTela('config');
            setUltimaPos(null);
            Vibration.vibrate([100, 100, 100]);
          }
        }
      ]
    );
  };

  // ── SCANNER QR ────────────────────────────────
  const abrirScanner = async () => {
    const { status } = await BarCodeScanner.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Câmera bloqueada', 'Permita o acesso à câmera para escanear o QR Code.');
      return;
    }
    setTemCamera(true);
    setTela('scanner');
  };

  const onQRLido = ({ data }) => {
    setTemCamera(false);
    setTela('config');
    // Tentar extrair token da URL
    try {
      const url = new URL(data);
      // Formato: https://servidor.com/rastreamento-api.php?id=TOKEN&...
      const t = url.searchParams.get('id') || url.searchParams.get('token') || url.searchParams.get('t');
      const s = `${url.protocol}//${url.host}${url.pathname}`;
      if (t) setToken(t);
      if (s) setServidor(s);
    } catch {
      // Se não for URL padrão, usar como token direto
      setToken(data);
    }
    Vibration.vibrate(300);
  };

  // ─────────────────────────────────────────────
  //  RENDER — TELA SCANNER
  // ─────────────────────────────────────────────
  if (tela === 'scanner') {
    return (
      <View style={s.scanContainer}>
        <StatusBar style="light"/>
        <BarCodeScanner
          onBarCodeScanned={temCamera ? onQRLido : undefined}
          style={StyleSheet.absoluteFillObject}
        />
        <View style={s.scanOverlay}>
          <View style={s.scanFrame}/>
          <Text style={s.scanTxt}>Aponte para o QR Code do rastreador</Text>
          <TouchableOpacity style={s.btnCancelarScan} onPress={()=>{setTemCamera(false);setTela('config')}}>
            <Text style={s.btnCancelarScanTxt}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─────────────────────────────────────────────
  //  RENDER — TELA RASTREANDO
  // ─────────────────────────────────────────────
  if (tela === 'rastreando') {
    return (
      <View style={s.container}>
        <StatusBar style="light"/>
        <KeepAwake/>
        <ScrollView contentContainerStyle={s.scroll}>

          {/* HEADER */}
          <View style={s.headerRastreando}>
            <View style={s.pulseWrap}>
              <View style={s.pulseRing}/>
              <View style={s.pulseRing2}/>
              <Text style={s.headerIcone}>📍</Text>
            </View>
            <Text style={s.headerTitulo}>RASTREAMENTO ATIVO</Text>
            <Text style={s.headerSub}>Funcionando mesmo com tela bloqueada</Text>
          </View>

          {/* STATUS CARD */}
          <View style={s.statusCard}>
            <View style={s.statusRow}>
              <View style={[s.statusDot, { backgroundColor: C.verde }]}/>
              <Text style={s.statusTxt}>Enviando localização</Text>
              <Text style={s.statusTotal}>{totalEnvios} envios</Text>
            </View>
            <Text style={s.statusServidor} numberOfLines={1}>
              🌐 {servidor}
            </Text>
            <Text style={s.statusToken} numberOfLines={1}>
              🔑 {token}
            </Text>
          </View>

          {/* POSIÇÃO ATUAL */}
          {ultimaPos ? (
            <View style={s.posCard}>
              <Text style={s.posCardTitulo}>📊 Última posição</Text>
              <View style={s.posGrid}>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>LAT</Text>
                  <Text style={s.posVal}>{parseFloat(ultimaPos.lat).toFixed(5)}</Text>
                </View>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>LNG</Text>
                  <Text style={s.posVal}>{parseFloat(ultimaPos.lng).toFixed(5)}</Text>
                </View>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>VELOC.</Text>
                  <Text style={s.posVal}>{ultimaPos.vel} <Text style={s.posUnit}>km/h</Text></Text>
                </View>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>PRECISÃO</Text>
                  <Text style={s.posVal}>{ultimaPos.prec} <Text style={s.posUnit}>m</Text></Text>
                </View>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>BATERIA</Text>
                  <Text style={[s.posVal, { color: ultimaPos.bat < 20 ? C.erro : C.verde }]}>
                    {ultimaPos.bat}%
                  </Text>
                </View>
                <View style={s.posItem}>
                  <Text style={s.posLabel}>HORÁRIO</Text>
                  <Text style={s.posVal}>{ultimaPos.hora}</Text>
                </View>
              </View>
            </View>
          ) : (
            <View style={s.aguardandoCard}>
              <ActivityIndicator color={C.verde} size="large"/>
              <Text style={s.aguardandoTxt}>Aguardando primeiro sinal GPS...</Text>
            </View>
          )}

          {/* DICA TELA BLOQUEADA */}
          <View style={s.dicaCard}>
            <Text style={s.dicaIcone}>💡</Text>
            <Text style={s.dicaTxt}>
              Você pode bloquear a tela normalmente. O rastreamento continua funcionando em segundo plano automaticamente.
            </Text>
          </View>

          {/* BOTÃO PARAR */}
          <TouchableOpacity style={s.btnParar} onPress={pararRastreamento}>
            <Text style={s.btnPararTxt}>⛔ Parar rastreamento</Text>
          </TouchableOpacity>

        </ScrollView>
      </View>
    );
  }

  // ─────────────────────────────────────────────
  //  RENDER — TELA CONFIGURAÇÃO
  // ─────────────────────────────────────────────
  return (
    <View style={s.container}>
      <StatusBar style="light"/>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* HEADER */}
        <View style={s.header}>
          <Text style={s.headerIconeConfig}>📡</Text>
          <Text style={s.headerTituloConfig}>Rastreador</Text>
          <Text style={s.headerSubConfig}>Polonorte</Text>
        </View>

        {/* CARD CONFIG */}
        <View style={s.card}>
          <Text style={s.cardTitulo}>⚙️ Configuração</Text>

          {/* SCANNER QR */}
          <TouchableOpacity style={s.btnQR} onPress={abrirScanner}>
            <Text style={s.btnQRTxt}>📷 Escanear QR Code</Text>
            <Text style={s.btnQRSub}>Leia o QR gerado pela plataforma</Text>
          </TouchableOpacity>

          <Text style={s.ouDivider}>— ou configure manualmente —</Text>

          {/* SERVIDOR */}
          <Text style={s.label}>URL do servidor</Text>
          <TextInput
            style={s.input}
            value={servidor}
            onChangeText={setServidor}
            placeholder="https://seusite.com/rastreamento-api.php"
            placeholderTextColor={C.txt2}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {/* TOKEN */}
          <Text style={s.label}>Token / ID da sessão</Text>
          <TextInput
            style={s.input}
            value={token}
            onChangeText={setToken}
            placeholder="Cole o token aqui"
            placeholderTextColor={C.txt2}
            autoCapitalize="none"
            autoCorrect={false}
          />

          {/* INTERVALO */}
          <Text style={s.label}>Intervalo de envio (segundos)</Text>
          <View style={s.intervalos}>
            {['5','10','15','30','60'].map(v => (
              <TouchableOpacity
                key={v}
                style={[s.intervaloBt, intervalo === v && s.intervaloBtAtivo]}
                onPress={() => setIntervalo(v)}
              >
                <Text style={[s.intervaloBtTxt, intervalo === v && s.intervaloBtTxtAtivo]}>
                  {v}s
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ERRO */}
          {erroMsg ? (
            <View style={s.erroBox}>
              <Text style={s.erroTxt}>⚠️ {erroMsg}</Text>
            </View>
          ) : null}

          {/* BOTÃO INICIAR */}
          <TouchableOpacity
            style={[s.btnIniciar, status === 'iniciando' && s.btnIniciarLoad]}
            onPress={iniciarRastreamento}
            disabled={status === 'iniciando'}
          >
            {status === 'iniciando' ? (
              <ActivityIndicator color="#fff" size="small"/>
            ) : (
              <Text style={s.btnIniciarTxt}>🚀 Iniciar rastreamento</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* INFO */}
        <View style={s.infoBox}>
          <Text style={s.infoTxt}>
            ✅ Funciona com tela bloqueada{'\n'}
            ✅ Continua após fechar o app{'\n'}
            ✅ Envia bateria, velocidade e precisão{'\n'}
            ✅ Notificação permanente indica que está ativo
          </Text>
        </View>

      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────
//  ESTILOS
// ─────────────────────────────────────────────────
const s = StyleSheet.create({
  container:   { flex:1, backgroundColor: C.bg },
  scroll:      { padding:20, paddingTop:56, paddingBottom:40 },

  // ── HEADER CONFIG ──
  header:           { alignItems:'center', marginBottom:28 },
  headerIconeConfig:{ fontSize:60, marginBottom:8 },
  headerTituloConfig:{ fontSize:28, fontWeight:'900', color:C.txt, letterSpacing:-0.5 },
  headerSubConfig:  { fontSize:14, color:C.dourado, fontWeight:'700', letterSpacing:2, marginTop:2 },

  // ── CARD ──
  card:       { backgroundColor:C.card, borderRadius:16, padding:20, borderWidth:1, borderColor:C.border, marginBottom:16 },
  cardTitulo: { fontSize:16, fontWeight:'800', color:C.txt, marginBottom:16 },

  // ── QR BUTTON ──
  btnQR:    { backgroundColor:C.verde2, borderRadius:12, padding:16, alignItems:'center', marginBottom:16, borderWidth:1, borderColor:C.verde },
  btnQRTxt: { fontSize:15, fontWeight:'800', color:'#fff' },
  btnQRSub: { fontSize:11, color:'rgba(255,255,255,.6)', marginTop:3 },

  ouDivider: { textAlign:'center', color:C.txt2, fontSize:12, marginBottom:16, letterSpacing:1 },

  // ── INPUTS ──
  label: { fontSize:12, fontWeight:'700', color:C.txt2, textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 },
  input: {
    backgroundColor:'#060f1e', borderWidth:2, borderColor:C.border,
    borderRadius:10, padding:13, fontSize:13, color:C.txt,
    marginBottom:16, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },

  // ── INTERVALOS ──
  intervalos:      { flexDirection:'row', gap:8, marginBottom:20 },
  intervaloBt:     { flex:1, paddingVertical:10, borderRadius:8, backgroundColor:'#060f1e', borderWidth:2, borderColor:C.border, alignItems:'center' },
  intervaloBtAtivo:{ backgroundColor:C.verde2, borderColor:C.verde },
  intervaloBtTxt:  { fontSize:13, fontWeight:'700', color:C.txt2 },
  intervaloBtTxtAtivo: { color:'#fff' },

  // ── ERRO ──
  erroBox: { backgroundColor:'rgba(239,68,68,.1)', borderRadius:8, padding:12, marginBottom:16, borderWidth:1, borderColor:'rgba(239,68,68,.3)' },
  erroTxt: { color:C.erro, fontSize:13, fontWeight:'600' },

  // ── BOTÃO INICIAR ──
  btnIniciar:    { backgroundColor:C.verde, borderRadius:12, padding:17, alignItems:'center', shadowColor:C.verde, shadowOffset:{width:0,height:0}, shadowOpacity:.5, shadowRadius:15, elevation:8 },
  btnIniciarLoad:{ opacity:.7 },
  btnIniciarTxt: { fontSize:16, fontWeight:'900', color:'#fff' },

  // ── INFO BOX ──
  infoBox: { backgroundColor:C.card2, borderRadius:12, padding:16, borderWidth:1, borderColor:'rgba(46,158,101,.2)' },
  infoTxt: { fontSize:13, color:'rgba(255,255,255,.6)', lineHeight:22 },

  // ── HEADER RASTREANDO ──
  headerRastreando: { alignItems:'center', paddingVertical:30 },
  pulseWrap:   { width:80, height:80, alignItems:'center', justifyContent:'center', marginBottom:16 },
  pulseRing:   { position:'absolute', width:80, height:80, borderRadius:40, borderWidth:2, borderColor:C.verde, opacity:.3 },
  pulseRing2:  { position:'absolute', width:60, height:60, borderRadius:30, borderWidth:2, borderColor:C.verde, opacity:.5 },
  headerIcone: { fontSize:36 },
  headerTitulo:{ fontSize:22, fontWeight:'900', color:C.verde, letterSpacing:2, marginBottom:6 },
  headerSub:   { fontSize:12, color:C.txt2, letterSpacing:.5 },

  // ── STATUS CARD ──
  statusCard:    { backgroundColor:C.card, borderRadius:14, padding:16, marginBottom:14, borderWidth:1, borderColor:C.border },
  statusRow:     { flexDirection:'row', alignItems:'center', marginBottom:10 },
  statusDot:     { width:10, height:10, borderRadius:5, marginRight:8 },
  statusTxt:     { fontSize:14, fontWeight:'700', color:C.txt, flex:1 },
  statusTotal:   { fontSize:12, color:C.dourado, fontWeight:'800' },
  statusServidor:{ fontSize:11, color:C.txt2, marginBottom:4 },
  statusToken:   { fontSize:11, color:C.txt2 },

  // ── POSIÇÃO ──
  posCard:     { backgroundColor:C.card, borderRadius:14, padding:16, marginBottom:14, borderWidth:1, borderColor:C.border },
  posCardTitulo:{ fontSize:14, fontWeight:'800', color:C.txt, marginBottom:14 },
  posGrid:     { flexDirection:'row', flexWrap:'wrap', gap:10 },
  posItem:     { width:'30%', backgroundColor:'#060f1e', borderRadius:10, padding:10, alignItems:'center' },
  posLabel:    { fontSize:9, fontWeight:'700', color:C.txt2, textTransform:'uppercase', letterSpacing:.5, marginBottom:4 },
  posVal:      { fontSize:16, fontWeight:'900', color:C.verde },
  posUnit:     { fontSize:10, fontWeight:'400', color:C.txt2 },

  aguardandoCard: { backgroundColor:C.card, borderRadius:14, padding:30, marginBottom:14, alignItems:'center', gap:14, borderWidth:1, borderColor:C.border },
  aguardandoTxt:  { color:C.txt2, fontSize:13 },

  // ── DICA ──
  dicaCard: { flexDirection:'row', gap:10, backgroundColor:'rgba(200,168,75,.08)', borderRadius:12, padding:14, marginBottom:20, borderWidth:1, borderColor:'rgba(200,168,75,.2)' },
  dicaIcone:{ fontSize:18 },
  dicaTxt:  { flex:1, fontSize:12, color:'rgba(255,255,255,.6)', lineHeight:18 },

  // ── PARAR ──
  btnParar:    { backgroundColor:'rgba(239,68,68,.12)', borderRadius:12, padding:16, alignItems:'center', borderWidth:1, borderColor:'rgba(239,68,68,.3)' },
  btnPararTxt: { fontSize:15, fontWeight:'800', color:C.erro },

  // ── SCANNER ──
  scanContainer: { flex:1, backgroundColor:'#000' },
  scanOverlay:   { flex:1, alignItems:'center', justifyContent:'flex-end', paddingBottom:60 },
  scanFrame:     {
    position:'absolute', top:'25%', left:'15%', right:'15%',
    height:220, borderRadius:16,
    borderWidth:2, borderColor:C.verde,
    shadowColor:C.verde, shadowOffset:{width:0,height:0}, shadowOpacity:1, shadowRadius:20,
  },
  scanTxt:       { color:'#fff', fontSize:14, fontWeight:'700', marginBottom:20, textShadowColor:'#000', textShadowRadius:6 },
  btnCancelarScan:   { backgroundColor:'rgba(255,255,255,.15)', borderRadius:10, paddingVertical:14, paddingHorizontal:40 },
  btnCancelarScanTxt:{ color:'#fff', fontSize:15, fontWeight:'800' },
});
