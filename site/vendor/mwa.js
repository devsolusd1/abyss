/* Mobile Wallet Adapter for Android. BUILT FILE, do not edit: the source is chain/src/mwa.mjs, rebuilt with `npm run build:mwa` in chain/. The licenses of the packages in it are at the end. */
var NoxMwa=(()=>{var tn=Object.defineProperty;var Xs=Object.getOwnPropertyDescriptor;var $s=Object.getOwnPropertyNames;var Zs=Object.prototype.hasOwnProperty;var qr=e=>{throw TypeError(e)};var Js=(e,t,n)=>t in e?tn(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;var Qs=(e,t)=>{for(var n in t)tn(e,n,{get:t[n],enumerable:!0})},ea=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of $s(t))!Zs.call(e,o)&&o!==n&&tn(e,o,{get:()=>t[o],enumerable:!(r=Xs(t,o))||r.enumerable});return e};var ta=e=>ea(tn({},"__esModule",{value:!0}),e);var u=(e,t,n)=>Js(e,typeof t!="symbol"?t+"":t,n),nr=(e,t,n)=>t.has(e)||qr("Cannot "+n);var i=(e,t,n)=>(nr(e,t,"read from private field"),n?n.call(e):t.get(e)),R=(e,t,n)=>t.has(e)?qr("Cannot add the same private member more than once"):t instanceof WeakSet?t.add(e):t.set(e,n),g=(e,t,n,r)=>(nr(e,t,"write to private field"),r?r.call(e,n):t.set(e,n),n),J=(e,t,n)=>(nr(e,t,"access private method"),n);var rr=(e,t,n,r)=>({set _(o){g(e,t,o,n)},get _(){return i(e,t,r)}});var Ic={};Qs(Ic,{register:()=>Tc});var nn=8078012;var or=8078026,Xr=8078027;function $r(e){return Array.isArray(e)?"%5B"+e.map($r).join("%2C%20")+"%5D":typeof e=="bigint"?`${e}n`:encodeURIComponent(String(e!=null&&Object.getPrototypeOf(e)===null?{...e}:e))}function na([e,t]){return`${e}=${$r(t)}`}function ra(e){let t=Object.entries(e).map(na).join("&");return btoa(t)}function oa(e,t={}){{let n=`Solana error #${e}; Decode this error by running \`npx @solana/errors decode -- ${e}`;return Object.keys(t).length&&(n+=` '${ra(t)}'`),`${n}\``}}var We=class extends Error{constructor(...[t,n]){let r,o;n&&Object.entries(Object.getOwnPropertyDescriptors(n)).forEach(([a,c])=>{a==="cause"?o={cause:c.value}:(r===void 0&&(r={__code:t}),Object.defineProperty(r,a,c))});let s=oa(t,r);super(s,o);u(this,"cause",this.cause);u(this,"context");this.context=Object.freeze(r===void 0?{__code:t}:r),this.name="SolanaError"}};function sa(e,t){return"fixedSize"in t?t.fixedSize:t.getSizeFromValue(e)}function rn(e){return Object.freeze({...e,encode:t=>{let n=new Uint8Array(sa(t,e));return e.write(t,n,0),n}})}function on(e){return Object.freeze({...e,decode:(t,n=0)=>e.read(t,n)[0]})}function aa(e,t,n=t){if(!t.match(new RegExp(`^[${e}]*$`)))throw new We(nn,{alphabet:e,base:e.length,value:n})}function ia(e){let t=e.isWellFormed;if(!(typeof t=="function"&&t.call(e)))for(let n=0;n<e.length;n++){let r=e.charCodeAt(n);if(r<55296||r>57343)continue;let o=e.charCodeAt(n+1);if(r<=56319&&o>=56320&&o<=57343){n++;continue}throw new We(Xr,{index:n,value:e})}}function no(e,t=0){let n=e.length,r=t;for(;r<n;){let o=e[r],s,a=128,c=191;if(o<128){r++;continue}else if(o>=194&&o<=223)s=1;else if(o>=224&&o<=239)s=2,o===224&&(a=160),o===237&&(c=159);else if(o>=240&&o<=244)s=3,o===240&&(a=144),o===244&&(c=143);else return r;let l=r;r++;for(let _=0;_<s;_++,r++){if(r>=n)return l;let d=e[r];if(!(_===0?d>=a&&d<=c:d>=128&&d<=191))return l}}return-1}function ca(e,t=0){let n=no(e,t);if(n!==-1)throw new We(or,{bytes:e,offset:n})}var la=e=>rn({getSizeFromValue:t=>{let[n,r]=Zr(t,e[0]);if(!r)return t.length;let o=Jr(r,e);return n.length+Math.ceil(o.toString(16).length/2)},write(t,n,r){if(aa(e,t),t==="")return r;let[o,s]=Zr(t,e[0]);if(!s)return n.set(new Uint8Array(o.length).fill(0),r),r+o.length;let a=Jr(s,e),c=[];for(;a>0n;)c.unshift(Number(a%256n)),a/=256n;let l=[...Array(o.length).fill(0),...c];return n.set(l,r),r+l.length}}),_a=e=>on({read(t,n){let r=n===0||n<=-t.byteLength?t:t.slice(n);if(r.length===0)return["",t.length];let o=r.findIndex(l=>l!==0);o=o===-1?r.length:o;let s=e[0].repeat(o);if(o===r.length)return[s,t.length];let a=r.slice(o).reduce((l,_)=>l*256n+BigInt(_),0n),c=da(a,e);return[s+c,t.length]}});function Zr(e,t){let[n,r]=e.split(new RegExp(`((?!${t}).*)`));return[n,r]}function Jr(e,t){let n=BigInt(t.length),r=0n;for(let o of e)r*=n,r+=BigInt(t.indexOf(o));return r}function da(e,t){let n=BigInt(t.length),r=[];for(;e>0n;)r.unshift(t[Number(e%n)]),e/=n;return r.join("")}var ro="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",oo=()=>la(ro),so=()=>_a(ro);var Qr="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",eo=32768;function Ra(e){let t="";for(let n=0;n<e.length;n+=eo)t+=String.fromCharCode(...e.subarray(n,n+eo));return t}var ao=()=>rn({getSizeFromValue:e=>{try{return atob(e).length}catch{throw new We(nn,{alphabet:Qr,base:64,value:e})}},write(e,t,n){try{let r=atob(e).split("").map(o=>o.charCodeAt(0));return t.set(r,n),r.length+n}catch{throw new We(nn,{alphabet:Qr,base:64,value:e})}}}),sr=()=>on({read(e,t=0){return[btoa(Ra(e.subarray(t))),e.length]}});var Ea=e=>e.replace(/\u0000/g,"");var ua=globalThis.TextDecoder,to=globalThis.TextEncoder,ar=(e={})=>{let t;return rn({getSizeFromValue:n=>(t||(t=new to)).encode(n).length,write:(n,r,o)=>{e.fatal&&ia(n);let s=(t||(t=new to)).encode(n);return r.set(s,o),o+s.length}})},io=(e={})=>{let t;return on({read(n,r){t||(t=new ua("utf-8",{fatal:e.fatal??!1,ignoreBOM:e.ignoreBOM??!1}));let o=e.fatal?fa(t,n,r):t.decode(n.slice(r));return!e.ignoreBOM&&t.ignoreBOM===void 0&&o.charCodeAt(0)===65279&&(o=o.slice(1)),e.removeNullCharacters!==!1&&(o=Ea(o)),[o,n.length]}})};function fa(e,t,n){let r=t.slice(n);if(!e.fatal)return ca(t,n),e.decode(r);try{return e.decode(r)}catch{throw new We(or,{bytes:t,offset:no(t,n)})}}function co(e){return sr().decode(ar().encode(e))}function Ae(e,t){let n=sr().decode(e);return t?n.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""):n}function Ye(e){return ao().encode(e)}function lo(e){return so().decode(e)}function Oa(e){return oo().encode(e)}function _o(e){return lo(Ye(e))}function Ct(e){return Ae(new Uint8Array(e))}function st(e){return lo(e)}function ir(e){return Oa(e)}function he(e){return Ae(e)}function Q(e){return Ye(e)}function cr(e){return io().decode(e)}function lr(e){return ar().encode(e)}var _r="solana:mainnet";var Aa=function(e,t,n,r){if(n==="a"&&!r)throw new TypeError("Private accessor was defined without a getter");if(typeof t=="function"?e!==t||!r:!t.has(e))throw new TypeError("Cannot read private member from an object whose class did not declare it");return n==="m"?r:n==="a"?r.call(e):r?r.value:t.get(e)},ha=function(e,t,n,r,o){if(r==="m")throw new TypeError("Private method is not writable");if(r==="a"&&!o)throw new TypeError("Private accessor was defined without a setter");if(typeof t=="function"?e!==t||!o:!t.has(e))throw new TypeError("Cannot write private member to an object whose class did not declare it");return r==="a"?o.call(e,n):o?o.value=n:t.set(e,n),n},sn;function an(e){let t=({register:n})=>n(e);try{window.dispatchEvent(new dr(t))}catch(n){console.error(`wallet-standard:register-wallet event could not be dispatched
`,n)}try{window.addEventListener("wallet-standard:app-ready",({detail:n})=>t(n))}catch(n){console.error(`wallet-standard:app-ready event listener could not be added
`,n)}}var dr=class extends Event{get detail(){return Aa(this,sn,"f")}get type(){return"wallet-standard:register-wallet"}constructor(t){super("wallet-standard:register-wallet",{bubbles:!1,cancelable:!1,composed:!1}),sn.set(this,void 0),ha(this,sn,t,"f")}preventDefault(){throw new Error("preventDefault cannot be called")}stopImmediatePropagation(){throw new Error("stopImmediatePropagation cannot be called")}stopPropagation(){throw new Error("stopPropagation cannot be called")}};sn=new WeakMap;var Sa=e=>e/2**32|0,Na=e=>e>>>0;function Ro(e,t,n,r){let o=Sa(n),s=Na(n);e.setUint32(t,r?s:o,r),e.setUint32(t+4,r?o:s,r)}function cn(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"&&"BYTES_PER_ELEMENT"in e&&e.BYTES_PER_ELEMENT===1}var Rr=e=>e?`"${e}" `:"";function yt(e,t=""){if(typeof e!="number")throw new TypeError(Rr(t)+"expected number, got "+typeof e);if(!Number.isSafeInteger(e)||e<0)throw new RangeError(Rr(t)+"expected integer >= 0, got "+e);return e}function Ce(e,t,n=""){if(cn(e)&&(t===void 0||e.length===t))return e;t!==void 0&&yt(t,"length");let r=cn(e),o=t!==void 0?` of length ${t}`:"",s=r?`length=${e.length}`:`type=${typeof e}`,a=Rr(n)+"expected Uint8Array"+o+", got "+s;throw r?new RangeError(a):new TypeError(a)}var pa=(e,t)=>{if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError((t==="object"?"":`"${t}" `)+"expected object, got type="+typeof e)},Eo=(e,t)=>{pa(e,t);let n=Object.getPrototypeOf(e);if(n!==Object.prototype&&n!==null)throw new TypeError(`"${t}" expected plain object`);if(Object.hasOwn(e,"__proto__"))throw new TypeError(`"${t}.__proto__" is not allowed`)};function Er(e,t=!0){if(e.destroyed)throw new Error("hash was destroyed");if(t&&e.finished)throw new Error("digest() was already called")}function fo(e,t){Ce(e,void 0,"output");let n=t.outputLen;if(!(e.length>=n))throw new RangeError('"output" expected length >= '+n)}function ur(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}function ln(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}function ue(e,t){return e<<32-t|e>>>t}var Oo=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",ma=Array.from({length:256},(e,t)=>t.toString(16).padStart(2,"0"));function Se(e){if(Ce(e),Oo)return e.toHex();let t="";for(let n=0;n<e.length;n++)t+=ma[e[n]];return t}function uo(e){return e>=48&&e<=57?e-48:e>=65&&e<=70?e-55:e>=97&&e<=102?e-87:void 0}function ye(e){if(typeof e!="string")throw new TypeError("hex string expected, got "+typeof e);if(Oo)try{return Uint8Array.fromHex(e)}catch(o){throw o instanceof SyntaxError?new RangeError(o.message):o}let t=e.length,n=t/2;if(t%2)throw new RangeError("hex string expected, got unpadded hex of length "+t);let r=new Uint8Array(n);for(let o=0,s=0;o<n;o++,s+=2){let a=uo(e.charCodeAt(s)),c=uo(e.charCodeAt(s+1));if(a===void 0||c===void 0){let l=e[s]+e[s+1];throw new RangeError('hex string expected, got non-hex character "'+l+'" at index '+s)}r[o]=a*16+c}return r}function Ao(...e){let t=0;for(let r=0;r<e.length;r++){let o=e[r];Ce(o),t+=o.length}let n=new Uint8Array(t);for(let r=0,o=0;r<e.length;r++){let s=e[r];n.set(s,o),o+=s.length}return n}function Ta(e,t,n="opts"){return Eo(e,"defaults"),t!==void 0&&Eo(t,n),Object.assign(Object.create(null),e,t)}function ho(e,t={}){if(typeof e!="function")throw new TypeError('"hashCons" expected function, got type='+typeof e);t=Ta({},t,"info");let n=(o,s)=>e(s).update(o).digest(),r=e(void 0);return n.outputLen=r.outputLen,n.blockLen=r.blockLen,n.canXOF=r.canXOF,n.create=o=>e(o),Object.assign(n,t),Object.freeze(n)}function Lt(e=32){yt(e,"bytesLength");let t=typeof globalThis=="object"?globalThis.crypto:null;if(typeof t?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");if(e>65536)throw new RangeError(`"bytesLength" expected <= 65536, got ${e}`);return t.getRandomValues(new Uint8Array(e))}var So=e=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,e])});function No(e,t,n){return e&t^~e&n}function po(e,t,n){return e&t^e&n^t&n}var _n=class{constructor(t,n,r,o){u(this,"blockLen");u(this,"outputLen");u(this,"canXOF",!1);u(this,"padOffset");u(this,"isLE");u(this,"buffer");u(this,"view");u(this,"finished",!1);u(this,"length",0);u(this,"pos",0);u(this,"destroyed",!1);this.blockLen=t,this.outputLen=n,this.padOffset=r,this.isLE=o,this.buffer=new Uint8Array(t),this.view=ln(this.buffer)}update(t){Er(this),Ce(t);let{view:n,buffer:r,blockLen:o}=this,s=t.length,a=!1;for(let c=0;c<s;){let l=Math.min(o-this.pos,s-c);if(l===o){let _=ln(t);for(;o<=s-c;c+=o)this.process(_,c);a=!0;continue}r.set(c===0&&l===s?t:t.subarray(c,c+l),this.pos),this.pos+=l,c+=l,this.pos===o&&(this.process(n,0),this.pos=0,a=!0)}return this.length+=t.length,a&&this.roundClean(),this}digestInto(t){Er(this),fo(t,this),this.finished=!0;let{buffer:n,view:r,blockLen:o,isLE:s}=this,{pos:a}=this;n[a++]=128,n.fill(0,a),this.padOffset>o-a&&(this.process(r,0),n.fill(0)),Ro(r,o-8,this.length*8,s),this.process(r,0),this.roundClean();let c=t===n?r:ln(t),l=this.outputLen,_=l/4,d=this.get();if(l%4||_>d.length)throw new Error("invalid outputLen");for(let A=0;A<_;A++)c.setUint32(4*A,d[A],s)}digest(){let{buffer:t,outputLen:n}=this;this.digestInto(t);let r=t.slice(0,n);return this.destroy(),r}_cloneIntoMeta(t){let{buffer:n,length:r,finished:o,destroyed:s,pos:a}=this;return t.destroyed=s,t.finished=o,t.length=r,t.pos=a,a&&t.buffer.set(n),t}clone(){return this._cloneInto()}},mo=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var Ia=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),Le=new Uint32Array(64),fr=class extends _n{constructor(n,r){super(64,n,8,!1);u(this,"A",0);u(this,"B",0);u(this,"C",0);u(this,"D",0);u(this,"E",0);u(this,"F",0);u(this,"G",0);u(this,"H",0);this.A=r[0]|0,this.B=r[1]|0,this.C=r[2]|0,this.D=r[3]|0,this.E=r[4]|0,this.F=r[5]|0,this.G=r[6]|0,this.H=r[7]|0}get(){let{A:n,B:r,C:o,D:s,E:a,F:c,G:l,H:_}=this;return[n,r,o,s,a,c,l,_]}set(n,r,o,s,a,c,l,_){this.A=n|0,this.B=r|0,this.C=o|0,this.D=s|0,this.E=a|0,this.F=c|0,this.G=l|0,this.H=_|0}_cloneInto(n){return(n||(n=new this.constructor)).set(...this.get()),this._cloneIntoMeta(n)}process(n,r){for(let h=0;h<16;h++,r+=4)Le[h]=n.getUint32(r,!1);for(let h=16;h<64;h++){let f=Le[h-15],N=Le[h-2],I=ue(f,7)^ue(f,18)^f>>>3,v=ue(N,17)^ue(N,19)^N>>>10;Le[h]=v+Le[h-7]+I+Le[h-16]|0}let{A:o,B:s,C:a,D:c,E:l,F:_,G:d,H:A}=this;for(let h=0;h<64;h++){let f=ue(l,6)^ue(l,11)^ue(l,25),N=A+f+No(l,_,d)+Ia[h]+Le[h]|0,v=(ue(o,2)^ue(o,13)^ue(o,22))+po(o,s,a)|0;A=d,d=_,_=l,l=c+N|0,c=a,a=s,s=o,o=N+v|0}o=o+this.A|0,s=s+this.B|0,a=a+this.C|0,c=c+this.D|0,l=l+this.E|0,_=_+this.F|0,d=d+this.G|0,A=A+this.H|0,this.set(o,s,a,c,l,_,d,A)}roundClean(){ur(Le)}destroy(){this.destroyed=!0,this.set(0,0,0,0,0,0,0,0),ur(this.buffer)}},Or=class extends fr{constructor(){super(32,mo)}};var at=ho(()=>new Or,So(1));function Rn(e,t,n=()=>{}){if(!Array.isArray(e))throw new TypeError(`"${t}" expected array, got type=${typeof e}`);for(let r=0;r<e.length;r++)n(e[r],`${t}[${r}]`);return e}var ie=(e,t,n)=>Ce(e,t,n),Ar=yt;function xe(e,t="object"){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError(t==="object"?"expected valid options object":`"${t}" expected object, got type=${typeof e}`);return e}function je(e,t){if(typeof e!="function")throw new TypeError(`"${t}" is invalid: expected function, got ${typeof e}`);return e}var Io=Se,it=(...e)=>Ao(...e),go=e=>ye(e),En=cn,wo=e=>Lt(e),dn=BigInt(0),To=BigInt(1),ga=e=>e?`"${e}" `:"";function De(e,t=""){if(typeof e!="boolean")throw new TypeError(ga(t)+"expected boolean, got type="+typeof e);return e}function wa(e){if(typeof e=="bigint"){if(!ve(e))throw new RangeError("positive bigint expected, got "+e)}else Ar(e);return e}function un(e,t=""){if(typeof e!="number"){let n=t&&`"${t}" `;throw new TypeError(n+"expected number, got type="+typeof e)}if(!Number.isSafeInteger(e)){let n=t&&`"${t}" `;throw new RangeError(n+"expected safe integer, got "+e)}}function bo(e){if(typeof e!="string")throw new TypeError("hex string expected, got "+typeof e);return e===""?dn:BigInt("0x"+e)}function Ue(e){return bo(Se(e))}function hr(e){return bo(Se(Nr(Ce(e)).reverse()))}function fn(e,t){if(yt(t),t===0)throw new Error("zero output length is invalid");e=wa(e);let n=t*2,r=e.toString(16);if(r.length>n)throw new RangeError("number is too large");return ye(r.padStart(n,"0"))}function Sr(e,t){return fn(e,t).reverse()}function Nr(e){return Uint8Array.from(ie(e))}function Co(e){if(typeof e!="string")throw new TypeError("ascii string expected, got "+typeof e);return Uint8Array.from(e,(t,n)=>{let r=t.charCodeAt(0);if(t.length!==1||r>127)throw new RangeError(`string contains non-ASCII character "${e[n]}" with code ${r} at position ${n}`);return r})}function ve(e){return typeof e=="bigint"&&dn<=e}function pr(e,t,n){return ve(e)&&ve(t)&&ve(n)&&t<=e&&e<n}function yo(e,t,n,r){if(!pr(t,n,r))throw new RangeError("expected valid "+e+": "+n+" <= n < "+r+", got "+t)}function ct(e){if(e<dn)throw new Error("expected non-negative bigint, got "+e);return e===dn?0:e.toString(2).length}var On=e=>(un(e,"n"),(To<<BigInt(e))-To);function An(e,t={},n={},r="object"){xe(e,r),xe(t,"fields"),xe(n,"optFields");function o(a,c,l){let _=r==="object"?`param "${String(a)}"`:`"${r}.${String(a)}"`,d=e[a];if(!Object.hasOwn(e,a)&&(l?d!==void 0:c!=="function"))throw new TypeError(`${_} is invalid: expected own property`);if(l&&d===void 0)return;let A=typeof d;if(A!==c||d===null)throw new TypeError(`${_} is invalid: expected ${c}, got ${A}`)}let s=(a,c)=>Object.entries(a).forEach(([l,_])=>o(l,_,c));s(t,!1),s(n,!0)}var ee=BigInt(0),G=BigInt(1),qe=BigInt(2),Do=BigInt(3),mr=BigInt(4),Uo=BigInt(5),ba=BigInt(7),Bo=BigInt(8),Ca=BigInt(9),ya=BigInt(15),Mo=BigInt(16),La=BigInt("0x10000000000000000");function fe(e,t){if(t<=ee)throw new Error("mod: expected positive modulus, got "+t);let n=e%t;return n>=ee?n:t+n}function xa(e,t,n){if(n<=G)throw new Error("pow: expected modulus > 1, got "+n);if(typeof t!="bigint")throw new TypeError("invalid exponent: expected bigint, got "+typeof t);if(t<ee)throw new Error("invalid exponent, negatives unsupported");if(t===ee)return G;if(t===G)return e;let r=e%n;if(r<ee&&(r+=n),t<La){let c=G;for(;t>ee;)t&G&&(c=c*r%n),r=r*r%n,t>>=G;return c}let o=[];for(;t>ee;)o.push(Number(t&ya)),t>>=mr;let s=new Array(16);s[0]=G,s[1]=r;for(let c=2;c<16;c++)s[c]=s[c-1]*r%n;let a=s[o[o.length-1]];for(let c=o.length-2;c>=0;c--){a=a*a%n,a=a*a%n,a=a*a%n,a=a*a%n;let l=o[c];l!==0&&(a=a*s[l]%n)}return a}function _e(e,t,n){if(n<=G)throw new Error("pow2: expected modulus > 1, got "+n);if(t<ee)throw new Error("pow2: expected non-negative exponent, got "+t);let r=e;for(;t-- >ee;)r*=r,r%=n;return r}function Lo(e,t){if(e===ee)throw new Error("invert: expected non-zero number");if(t<=G)throw new Error("invert: expected modulus > 1, got "+t);let n=fe(e,t),r=t,o=ee,s=G;for(;n!==ee;){let c=r/n,l=r-n*c,_=o-s*c;r=n,n=l,o=s,s=_}if(r!==G)throw new Error("invert: does not exist");return fe(o,t)}function Tr(e,t,n){let r=e;if(!r.eql(r.sqr(t),n))throw new Error("Cannot find square root")}function Ir(e,t){if((e&G)===ee)throw new Error(t+": expected odd modulus, got "+e)}function Po(e,t){let n=e,r=(n.ORDER+G)/mr,o=n.pow(t,r);return Tr(n,o,t),o}function va(e,t){let n=e,r=(n.ORDER-Uo)/Bo,o=n.mul(t,qe),s=n.pow(o,r),a=n.mul(t,s),c=n.mul(n.mul(a,qe),s),l=n.mul(a,n.sub(c,n.ONE));return Tr(n,l,t),l}function Da(e){let t=_t(e),n=Fo(e),r=n(t,t.neg(t.ONE)),o=n(t,r),s=n(t,t.neg(r)),a=(e+ba)/Mo;return((c,l)=>{let _=c,d=_.pow(l,a),A=_.mul(d,r),h=_.mul(d,o),f=_.mul(d,s),N=_.eql(_.sqr(A),l),I=_.eql(_.sqr(h),l);d=_.cmov(d,A,N),A=_.cmov(f,h,I);let v=_.eql(_.sqr(A),l),B=_.cmov(d,A,v);return Tr(_,B,l),B})}function Fo(e){if(e<Do)throw new Error("sqrt is not defined for small field");Ir(e,"tonelliShanks");let t=e-G,n=0;for(;t%qe===ee;)t/=qe,n++;let r=qe,o=_t(e);for(;xo(o,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return Po;let s=o.pow(r,t),a=(t+G)/qe;return function(l,_){let d=l;if(d.is0(_))return _;if(xo(d,_)!==1)throw new Error("Cannot find square root");let A=n,h=d.mul(d.ONE,s),f=d.pow(_,t),N=d.pow(_,a);for(;!d.eql(f,d.ONE);){if(d.is0(f))throw new Error("Cannot find square root: probably non-prime P");let I=1,v=d.sqr(f);for(;!d.eql(v,d.ONE);)if(I++,v=d.sqr(v),I===A)throw new Error("Cannot find square root");let B=G<<BigInt(A-I-1),K=d.pow(h,B);A=I,h=d.sqr(K),f=d.mul(f,h),N=d.mul(N,K)}return N}}function Ua(e){return Ir(e,"Fp.sqrt"),e%mr===Do?Po:e%Bo===Uo?va:e%Mo===Ca?Da(e):Fo(e)}var Ba=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function lt(e){if(xe(e,"field"),typeof e.ORDER!="bigint")throw new TypeError('param "ORDER" is invalid: expected bigint, got '+typeof e.ORDER);un(e.BYTES,"BYTES"),un(e.BITS,"BITS");for(let t of Ba)je(e[t],"field."+t);if(e.BYTES<1||e.BITS<1)throw new Error("invalid field: expected BYTES/BITS > 0");if(e.ORDER<=G)throw new Error("invalid field: expected ORDER > 1, got "+e.ORDER);return e}function gr(e,t,n=!1){lt(e),Rn(t,"nums"),De(n,"passZero");let r=e,o=new Array(t.length).fill(n?r.ZERO:void 0),s=t.reduce((c,l,_)=>r.is0(l)?c:(o[_]=c,r.mul(c,l)),r.ONE),a=r.inv(s);return t.reduceRight((c,l,_)=>r.is0(l)?c:(o[_]=r.mul(c,o[_]),r.mul(c,l)),a),o}function xo(e,t){lt(e);let n=e;Ir(n.ORDER,"FpLegendre");let r=(n.ORDER-G)/qe,o=n.pow(t,r),s=n.eql(o,n.ONE),a=n.eql(o,n.ZERO),c=n.eql(o,n.neg(n.ONE));if(!s&&!a&&!c)throw new Error("invalid Legendre symbol result");return s?1:a?0:-1}function Ma(e,t){if(t!==void 0&&Ar(t),e<=ee)throw new Error("invalid n length: expected positive n, got "+e);if(t!==void 0&&t<1)throw new Error("invalid n length: expected positive bit length, got "+t);let n=ct(e);if(t!==void 0&&t<n)throw new Error(`invalid n length: expected nBitLength (${t}) >= bitLen(n) (${n})`);let r=t!==void 0?t:n,o=Math.ceil(r/8);return{nBitLength:r,nByteLength:o}}var vo=new WeakMap,hn=class{constructor(t,n={}){u(this,"ORDER");u(this,"BITS");u(this,"BYTES");u(this,"isLE");u(this,"ZERO",ee);u(this,"ONE",G);u(this,"_lengths");u(this,"_mod");if(t<=G)throw new Error("invalid field: expected ORDER > 1, got "+t);let r;this.isLE=!1,n!=null&&typeof n=="object"&&(typeof n.BITS=="number"&&(r=n.BITS),typeof n.sqrt=="function"&&Object.defineProperty(this,"sqrt",{value:n.sqrt,enumerable:!0}),typeof n.isLE=="boolean"&&(this.isLE=n.isLE),n.allowedLengths&&(this._lengths=Object.freeze(n.allowedLengths.slice())),typeof n.modFromBytes=="boolean"&&(this._mod=n.modFromBytes));let{nBitLength:o,nByteLength:s}=Ma(t,r);if(s>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=t,this.BITS=o,this.BYTES=s,Object.freeze(this)}create(t){return fe(t,this.ORDER)}isValid(t){if(typeof t!="bigint")throw new TypeError("invalid field element: expected bigint, got "+typeof t);return ee<=t&&t<this.ORDER}is0(t){return t===ee}isValidNot0(t){return!this.is0(t)&&this.isValid(t)}isOdd(t){return(t&G)===G}neg(t){return fe(-t,this.ORDER)}eql(t,n){return t===n}sqr(t){return fe(t*t,this.ORDER)}add(t,n){return fe(t+n,this.ORDER)}sub(t,n){return fe(t-n,this.ORDER)}mul(t,n){return fe(t*n,this.ORDER)}pow(t,n){return xa(t,n,this.ORDER)}div(t,n){return fe(t*Lo(n,this.ORDER),this.ORDER)}sqrN(t){return t*t}addN(t,n){return t+n}subN(t,n){return t-n}mulN(t,n){return t*n}inv(t){return Lo(t,this.ORDER)}sqrt(t){let n=vo.get(this);return n||vo.set(this,n=Ua(this.ORDER)),n(this,t)}toBytes(t){return this.isLE?Sr(t,this.BYTES):fn(t,this.BYTES)}fromBytes(t,n=!1){ie(t);let{_lengths:r,BYTES:o,isLE:s,ORDER:a,_mod:c}=this;if(r){if(t.length<1||!r.includes(t.length)||t.length>o)throw new Error("Field.fromBytes: expected "+r+" bytes, got "+t.length);let _=new Uint8Array(o);_.set(t,s?0:_.length-t.length),t=_}if(t.length!==o)throw new Error("Field.fromBytes: expected "+o+" bytes, got "+t.length);let l=s?hr(t):Ue(t);if(c&&(l=fe(l,a)),!n&&!this.isValid(l))throw new Error("invalid field element: outside of range 0..ORDER");return l}invertBatch(t){return gr(this,t,!0)}cmov(t,n,r){return De(r,"condition"),r?n:t}};function _t(e,t={}){return Object.freeze(hn.prototype),new hn(e,t)}function Ho(e){if(typeof e!="bigint")throw new Error("field order must be bigint");if(e<=G)throw new Error("field order must be greater than 1");let t=ct(e-G);return Math.ceil(t/8)}function Pa(e){let t=Ho(e);return t+Math.ceil(t/2)}function Go(e,t,n=!1){ie(e);let r=e.length,o=Ho(t),s=Math.max(Pa(t),16);if(r<s||r>1024)throw new Error("expected "+s+"-1024 bytes of input, got "+r);let a=n?hr(e):Ue(e),c=fe(a,t-G)+G;return n?Sr(c,o):fn(c,o)}var Cr=BigInt(0),xt=BigInt(1),Fa=BigInt(4),wr=16,ko=128,Ha=5,Vo=2**31;function Nn(e){let t=e;if(typeof t!="function")throw new TypeError('"Point" expected constructor, got type='+typeof e);je(t.fromAffine,"Point.fromAffine"),je(t.fromBytes,"Point.fromBytes"),je(t.fromHex,"Point.fromHex"),xe(t.BASE,"Point.BASE"),xe(t.ZERO,"Point.ZERO"),lt(t.Fp),lt(t.Fn)}function Ko(e,t){Nn(e),Yo(t,e);let n=gr(e.Fp,t.map(r=>r.Z));return t.map((r,o)=>e.fromAffine(r.toAffine(n[o])))}function Ga(e,t,n=1){if(!Number.isSafeInteger(e)||e<n||e>t)throw new Error("invalid window size, expected ["+n+".."+t+"], got W="+e)}function ka(e,t){let n=e*(4*t+128);if(n>Vo)throw new Error("invalid window size: table would need ~"+Math.ceil(n/2**20)+" MiB, max "+Vo/2**20+" MiB")}function Wo(e,t){if(e!==void 0){je(e,"randomBytes");try{let n=e(t);if(!En(n)||n.length!==t)return}catch{return}return e}}function Yo(e,t){Rn(e,"points"),e.forEach((n,r)=>{if(!(n instanceof t))throw new Error("invalid point at index "+r)})}function Va(e,t,n){if(!Array.isArray(e))throw new Error("array of scalars expected");e.forEach((r,o)=>{if(!(n===void 0?t.isValid(r):ve(r)&&r<n))throw new Error("invalid scalar at index "+o)})}var jo=new WeakMap;function br(e){return jo.get(e)||1}function za(e,t){let n=e.double(),r=[e];for(let o=1;o<t;o++)r.push(r[o-1].add(n));return r}function Ka(e,t){let n=2**t,r=n/2,o=BigInt(n-1),s=[];for(;e>Cr;){let a=0;e&xt&&(a=Number(e&o),a>=r&&(a-=n),e-=BigInt(a)),s.push(a),e>>=xt}return s}function Wa(e,t,n){let r=2**t,o=r/2,s=BigInt(r-1),a=BigInt(t),c=[];for(let l=0;l<n;l++){let _=Number(e&s);e>>=a,_>o&&(_-=r,e+=xt),c.push(_)}if(e!==Cr)throw new Error("invalid wnaf");return c}function Ya(e,t,n){let r=0;for(let s of n)r=Math.max(r,s.length);let o=e;for(let s=r-1;s>=0;s--){s!==r-1&&(o=o.double());for(let a=0;a<n.length;a++){let c=n[a][s];if(c){let l=t[a][Math.abs(c)-1>>1];o=o.add(c<0?l.negate():l)}}}return o}var Sn=class{constructor(t,n){u(this,"Point");u(this,"BASE");u(this,"ZERO");u(this,"randomBytes");u(this,"wnafPrecomputes",new WeakMap);u(this,"baseCanBeBlinded");u(this,"bits");Nn(t),this.randomBytes=Wo(n,wr),this.Point=t,this.BASE=t.BASE,this.ZERO=t.ZERO,this.bits=t.Fn.BITS}buildWnafTable(t,n,r){let o=Math.ceil(r/n)+1,s=2**(n-1),a=[],c=t;for(let l=0;l<o;l++){let _=c;for(let d=0;d<s;d++)a.push(_),_=_.add(c);c=a[a.length-1].double()}return{W:n,bits:r,windows:o,comp:a}}wnafCachedCT(t,n){let{W:r,windows:o,comp:s}=t,a=2**(r-1),c=Wa(n,r,o),l=this.ZERO,_=this.BASE;for(let d=0;d<o;d++){let A=c[d],h=d*a,f=Math.abs(A)-1,N=s[h];for(let v=1;v<a;v++)N=v===f?s[h+v]:N;let I=N.negate();A===0?_=_.add(s[h]):l=l.add(A<0?I:N)}return{p:l,f:_}}getWnafPrecomputes(t,n,r,o){let s=this.wnafPrecomputes.get(n),a=s?.find(c=>c.W===t&&c.bits===r);return a||(a=this.buildWnafTable(n,t,r),typeof o=="function"&&(a={...a,comp:o(a.comp)}),s||(s=[],this.wnafPrecomputes.set(n,s)),s.push(a)),a}assertPoint(t){if(!(t instanceof this.Point))throw new TypeError('"point" expected Point instance, got type='+typeof t)}validateMulInput(t,n){if(this.assertPoint(t),!pr(n,xt,this.Point.Fn.ORDER))throw new Error("invalid scalar")}runCT(t,n,r,o){let s=br(t);return s===1?this.fixedWindowCT(t,n,r):this.wnafCachedCT(this.getWnafPrecomputes(s,t,r,o),n)}mulCT(t,n,r){return this.validateMulInput(t,n),this.runCT(t,n,this.bits,r)}mulCTBlinded(t,n,r){if(this.validateMulInput(t,n),this.randomBytes===void 0)throw new Error("randomBytes is required for scalar blinding");let o=this.Point.Fn.BITS+ko,s=this.randomBytes(wr);if(!En(s)||s.length!==wr)throw new Error("randomBytes returned invalid byte array");s[0]=s[0]&63|128;let a=n+Ue(s)*this.Point.Fn.ORDER;return this.runCT(t,a,o,r)}fixedWindowCT(t,n,r){let o=Ha,s=1<<o,a=On(o),c=new Array(s);c[0]=this.ZERO;for(let d=1;d<s;d++)c[d]=c[d-1].add(t);let l=Math.ceil(r/o),_=this.ZERO;for(let d=l-1;d>=0;d--){if(d!==l-1)for(let f=0;f<o;f++)_=_.double();let A=Number(n>>BigInt(d*o)&a),h=c[0];for(let f=1;f<s;f++)h=f===A?c[f]:h;_=_.add(h)}return{p:_,f:_}}shouldBlind(t,n){return this.randomBytes===void 0?!1:n===xt?!0:t!==this.BASE?!1:(this.baseCanBeBlinded===void 0&&(this.baseCanBeBlinded=this.mulUnsafe(this.BASE,this.Point.Fn.ORDER).is0()),this.baseCanBeBlinded)}mulSecret(t,n,r,o){return this.shouldBlind(t,r)?this.mulCTBlinded(t,n,o):this.mulCT(t,n,o)}mulUnsafe(t,n,r){if(this.assertPoint(t),!ve(n))throw new Error("invalid scalar");let o=br(t);if(o===1||n>=this.Point.Fn.ORDER)return pn(this.Point,[t],[n],!0);let s=this.getWnafPrecomputes(o,t,this.bits,r);return this.wnafCachedCT(s,n).p}setWindowSize(t,n){this.assertPoint(t),Ga(n,this.bits);let r=Math.ceil((this.bits+ko)/n)+1;ka(r*2**(n-1),this.Point.Fp.BYTES),jo.set(t,n),this.wnafPrecomputes.delete(t)}hasWindowSize(t){return br(t)!==1}};function pn(e,t,n,r=!1){if(Nn(e),Yo(t,e),De(r,"allowOversized"),Va(n,e.Fn,r?e.Fn.ORDER**Fa:void 0),t.length!==n.length)throw new Error("arrays of points and scalars must have equal length");let o=t.map(a=>za(a,4)),s=n.map(a=>Ka(a,4));return Ya(e.ZERO,o,s)}function zo(e,t,n){if(t){if(t.ORDER!==e)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return lt(t),t}else return _t(e,{isLE:n})}function qo(e,t,n={},r){if(e!=="weierstrass"&&e!=="edwards")throw new Error('expected curve type "weierstrass" or "edwards"');if(r===void 0&&(r=e==="edwards"),!t||typeof t!="object")throw new Error(`expected valid ${e} CURVE object`);An(n);for(let l of["p","n","h"]){let _=t[l];if(!(ve(_)&&_!==Cr))throw new Error(`CURVE.${l} must be positive bigint`)}let o=zo(t.p,n.Fp,r),s=zo(t.n,n.Fn,r),c=["Gx","Gy","a",e==="weierstrass"?"b":"d"];for(let l of c)if(!o.isValid(t[l]))throw new Error(`CURVE.${l} must be valid field element of CURVE.Fp`);return t=Object.freeze(Object.assign({},t)),{CURVE:t,Fp:o,Fn:s}}function yr(e,t){return function(r){let o=e(r);return{secretKey:o,publicKey:t(o)}}}var Xo=(e,t)=>(e+(e>=0?t:-t)/qa)/t;function ja(e,t,n){yo("scalar",e,dt,n);let[[r,o],[s,a]]=t,c=Xo(a*e,n),l=Xo(-o*e,n),_=e-c*r-l*s,d=-c*o-l*a,A=_<dt,h=d<dt;A&&(_=-_),h&&(d=-d);let f=On(Math.ceil(ct(n)/2))+vt;if(_<dt||_>=f||d<dt||d>=f)throw new Error("splitScalar (endomorphism): failed for k");return{k1neg:A,k1:_,k2neg:h,k2:d}}var dt=BigInt(0),vt=BigInt(1),qa=BigInt(2),Lr=BigInt(3),Xa=BigInt(4);function $o(e,t={}){let n=qo("weierstrass",e,t),r=n.Fp,o=n.Fn,s=n.CURVE,{h:a,n:c}=s;An(t,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object",randomBytes:"function"});let{endo:l,allowInfinityPoint:_,clearCofactor:d,isTorsionFree:A,fromBytes:h,toBytes:f}=t,N=t.randomBytes===void 0?wo:t.randomBytes;if(l&&(!r.is0(s.a)||typeof l.beta!="bigint"||!Array.isArray(l.basises)))throw new Error('invalid endo: expected "beta": bigint and "basises": array');let I=l?{beta:l.beta,basises:l.basises.map(L=>[...L])}:void 0,v=Za(r,o);function B(){if(!r.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function K(L,E,O){if(E.is0()){if(!_)throw new Error("bad point: ZERO");return Uint8Array.of(0)}let{x:p,y:T}=E.toAffine(),D=r.toBytes(p);if(De(O,"isCompressed"),O){B();let C=!r.isOdd(T);return it($a(C),D)}else return it(Uint8Array.of(4),D,r.toBytes(T))}function $(L){ie(L,void 0,"Point");let{publicKey:E,publicKeyUncompressed:O}=v,p=L.length,T=L[0],D=L.subarray(1);if(_&&p===1&&T===0)return{x:r.ZERO,y:r.ZERO};if(p===E&&(T===2||T===3)){let C=r.fromBytes(D);if(!r.isValid(C))throw new Error("bad point: is not on curve, wrong x");let M=x(C),U;try{U=r.sqrt(M)}catch(Z){let se=Z instanceof Error?": "+Z.message:"";throw new Error("bad point: is not on curve, sqrt error"+se)}B();let V=r.isOdd(U);return(T&1)===1!==V&&(U=r.neg(U)),{x:C,y:U}}else if(p===O&&T===4){let C=r.BYTES,M=r.fromBytes(D.subarray(0,C)),U=r.fromBytes(D.subarray(C,C*2));if(!H(M,U))throw new Error("bad point: is not on curve");return{x:M,y:U}}else throw new Error(`bad point: got length ${p}, expected compressed=${E} or uncompressed=${O}`)}let z=f===void 0?K:f,F=h===void 0?$:h,S=r.mul(s.b,Lr),m=r.is0(s.a)?L=>r.ZERO:L=>r.mul(s.a,L);function x(L){let E=r.sqr(L),O=r.mul(E,L);return r.add(r.add(O,r.mul(L,s.a)),s.b)}function H(L,E){let O=r.sqr(E),p=x(L);return r.eql(O,p)}if(!H(s.Gx,s.Gy))throw new Error("bad curve params: generator point");let q=r.mul(r.pow(s.a,Lr),Xa),be=r.mul(r.sqr(s.b),BigInt(27));if(r.is0(r.add(q,be)))throw new Error("bad curve params: a or b");function j(L,E,O=!1){if(!r.isValid(E)||O&&r.is0(E))throw new Error(`bad point coordinate ${L}`);return typeof E=="object"&&E!==null?r.create(E):E}function te(L){if(!(L instanceof k))throw new Error("Weierstrass Point expected")}function Te(L){if(!I||!I.basises)throw new Error("no endo");return ja(L,I.basises,o.ORDER)}function Re(L,E,O,p){if(!o.isValid(p))throw new RangeError("invalid scalar: out of range");if(I){let{k1neg:T,k1:D,k2neg:C,k2:M}=Te(p),U=new k(r.mul(O.X,I.beta),O.Y,O.Z);L.push(T?O.negate():O,C?U.negate():U),E.push(D,M)}else L.push(O),E.push(p)}let W=new WeakSet,b=class b{constructor(E,O,p){u(this,"X");u(this,"Y");u(this,"Z");this.X=j("x",E),this.Y=j("y",O,!0),this.Z=j("z",p),Object.freeze(this)}static CURVE(){return s}static fromAffine(E){let{x:O,y:p}=E||{};if(!E||!r.isValid(O)||!r.isValid(p))throw new Error("invalid affine point");if(E instanceof b)throw new Error("projective point not allowed");return r.is0(O)&&r.is0(p)?b.ZERO:new b(O,p,r.ONE)}static fromBytes(E){let O=b.fromAffine(F(ie(E,void 0,"point")));return O.assertValidity(),O}static fromHex(E){return b.fromBytes(go(E))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(E=6,O=!0){return Y.setWindowSize(this,E),O||this.multiply(Lr),this}assertValidity(){let E=this;if(E.is0()){if(_&&r.is0(E.X)&&r.eql(E.Y,r.ONE)&&r.is0(E.Z))return;throw new Error("bad point: ZERO")}if(W.has(E))return;let{x:O,y:p}=E.toAffine();if(!r.isValid(O)||!r.isValid(p))throw new Error("bad point: x or y not field elements");if(!H(O,p))throw new Error("bad point: equation left != right");if(!E.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");W.add(E)}hasEvenY(){let{y:E}=this.toAffine();if(!r.isOdd)throw new Error("Field doesn't support isOdd");return!r.isOdd(E)}equals(E){te(E);let{X:O,Y:p,Z:T}=this,{X:D,Y:C,Z:M}=E,U=r.eql(r.mul(O,M),r.mul(D,T)),V=r.eql(r.mul(p,M),r.mul(C,T));return U&&V}negate(){return new b(this.X,r.neg(this.Y),this.Z)}double(){let{X:E,Y:O,Z:p}=this,T=r.ZERO,D=r.ZERO,C=r.ZERO,M=r.mul(E,E),U=r.mul(O,O),V=r.mul(p,p),P=r.mul(E,O);return P=r.add(P,P),C=r.mul(E,p),C=r.add(C,C),T=m(C),D=r.mul(S,V),D=r.add(T,D),T=r.sub(U,D),D=r.add(U,D),D=r.mul(T,D),T=r.mul(P,T),C=r.mul(S,C),V=m(V),P=r.sub(M,V),P=m(P),P=r.add(P,C),C=r.add(M,M),M=r.add(C,M),M=r.add(M,V),M=r.mul(M,P),D=r.add(D,M),V=r.mul(O,p),V=r.add(V,V),M=r.mul(V,P),T=r.sub(T,M),C=r.mul(V,U),C=r.add(C,C),C=r.add(C,C),new b(T,D,C)}add(E){te(E);let{X:O,Y:p,Z:T}=this,{X:D,Y:C,Z:M}=E,U=r.ZERO,V=r.ZERO,P=r.ZERO,Z=r.mul(O,D),se=r.mul(p,C),Ee=r.mul(T,M),ot=r.add(O,p),ae=r.add(D,C);ot=r.mul(ot,ae),ae=r.add(Z,se),ot=r.sub(ot,ae),ae=r.add(O,T);let Oe=r.add(D,M);return ae=r.mul(ae,Oe),Oe=r.add(Z,Ee),ae=r.sub(ae,Oe),Oe=r.add(p,T),U=r.add(C,M),Oe=r.mul(Oe,U),U=r.add(se,Ee),Oe=r.sub(Oe,U),P=m(ae),U=r.mul(S,Ee),P=r.add(U,P),U=r.sub(se,P),P=r.add(se,P),V=r.mul(U,P),se=r.add(Z,Z),se=r.add(se,Z),Ee=m(Ee),ae=r.mul(S,ae),se=r.add(se,Ee),Ee=r.sub(Z,Ee),Ee=m(Ee),ae=r.add(ae,Ee),Z=r.mul(se,ae),V=r.add(V,Z),Z=r.mul(Oe,ae),U=r.mul(ot,U),U=r.sub(U,Z),Z=r.mul(ot,se),P=r.mul(Oe,P),P=r.add(P,Z),new b(U,V,P)}subtract(E){return te(E),this.add(E.negate())}is0(){return this.equals(b.ZERO)}multiply(E){if(!o.isValidNot0(E))throw new RangeError("invalid scalar: out of range");let{p:O,f:p}=Y.mulSecret(this,E,a,ce);return ce([O,p])[0]}multiplyUnsafe(E){let O=this,p=E;if(!o.isValid(p))throw new RangeError("invalid scalar: out of range");if(p===dt||O.is0())return b.ZERO;if(p===vt)return O;if(Y.hasWindowSize(this))return Y.mulUnsafe(O,p,ce);let T=[],D=[];return Re(T,D,O,p),pn(b,T,D)}mulAddUnsafe(E,O,p){te(O);let T=[],D=[];return Re(T,D,this,E),Re(T,D,O,p),pn(b,T,D)}toAffine(E){let O=this,p=E;if(p!=null&&!r.isValid(p))throw new RangeError('"invertedZ" expected valid field element');let{X:T,Y:D,Z:C}=O;if(r.eql(C,r.ONE))return{x:T,y:D};let M=O.is0();p==null&&(p=M?r.ONE:r.inv(C));let U=r.mul(T,p),V=r.mul(D,p),P=r.mul(C,p);if(M)return{x:r.ZERO,y:r.ZERO};if(!r.eql(P,r.ONE))throw new Error("invZ was invalid");return{x:U,y:V}}isTorsionFree(){return a===vt?!0:A?A(b,this):Y.mulUnsafe(this,c).is0()}clearCofactor(){return a===vt?this:d?d(b,this):this.multiplyUnsafe(a)}isSmallOrder(){return a===vt?this.is0():this.clearCofactor().is0()}toBytes(E=!0){return De(E,"isCompressed"),this.assertValidity(),z(b,this,E)}toHex(E=!0){return Io(this.toBytes(E))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}};u(b,"BASE",new b(s.Gx,s.Gy,r.ONE)),u(b,"ZERO",new b(r.ZERO,r.ONE,r.ZERO)),u(b,"Fp",r),u(b,"Fn",o);let k=b,ce=L=>Ko(k,L),Y=new Sn(k,N);return Y.bits>=6&&k.BASE.precompute(6),Object.freeze(k.prototype),Object.freeze(k),k}function $a(e){return Uint8Array.of(e?2:3)}function Za(e,t){return{secretKey:t.BYTES,publicKey:1+e.BYTES,publicKeyUncompressed:1+2*e.BYTES,publicKeyHasPrefix:!0,signature:2*t.BYTES}}var Tn={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},Ja={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},Qa=BigInt(0),Zo=BigInt(2);function ei(e){let t=Tn.p,n=BigInt(3),r=BigInt(6),o=BigInt(11),s=BigInt(22),a=BigInt(23),c=BigInt(44),l=BigInt(88),_=e*e*e%t,d=_*_*e%t,A=_e(d,n,t)*d%t,h=_e(A,n,t)*d%t,f=_e(h,Zo,t)*_%t,N=_e(f,o,t)*f%t,I=_e(N,s,t)*N%t,v=_e(I,c,t)*I%t,B=_e(v,l,t)*v%t,K=_e(B,c,t)*I%t,$=_e(K,n,t)*d%t,z=_e($,a,t)*N%t,F=_e(z,r,t)*_%t,S=_e(F,Zo,t);if(!Et.eql(Et.sqr(S),e))throw new Error("Cannot find square root");return S}var Et=_t(Tn.p,{sqrt:ei}),ut=$o(Tn,{Fp:Et,endo:Ja});var Jo=Object.create(null);function mn(e,...t){let n=Jo[e];if(n===void 0){let r=at(Co(e));n=it(r,r),Jo[e]=n}return at(it(n,...t))}var es=e=>e.toBytes(!0).slice(1),ts=({x:e})=>Et.toBytes(e),In=e=>!Et.isOdd(e);function ns(e){let{Fn:t,BASE:n}=ut,r=t.fromBytes(ie(e,32,"secretKey")),s=n.multiply(r).toAffine();return{scalar:In(s.y)?r:t.neg(r),bytes:ts(s)}}function rs(e){let t=Et;if(!t.isValidNot0(e))throw new Error("invalid x: Fail if x \u2265 p");let n=t.sqr(e),r=t.add(t.mulN(n,e),BigInt(7)),o=t.sqrt(r);In(o)||(o=t.neg(o));let s=ut.fromAffine({x:e,y:o});return s.assertValidity(),s}var Rt=Ue;function os(...e){return ut.Fn.create(Rt(mn("BIP0340/challenge",...e)))}function Qo(e){return ns(e).bytes}function ti(e,t,n=Lt(32)){let{Fn:r,BASE:o}=ut,s=Nr(ie(e,void 0,"message")),{bytes:a,scalar:c}=ns(t),l=ie(n,32,"auxRand"),_=r.toBytes(c^Rt(mn("BIP0340/aux",l))),d=mn("BIP0340/nonce",_,a,s),A=r.create(Rt(d));if(A===Qa)throw new Error("sign failed: k is zero");let f=o.multiply(A).toAffine(),N=In(f.y)?A:r.neg(A),I=ts(f),v=os(I,a,s),B=new Uint8Array(64);if(B.set(I,0),B.set(r.toBytes(r.create(N+v*c)),32),!ss(B,s,a))throw new Error("sign: Invalid signature produced");return B}function ss(e,t,n){let{Fp:r,Fn:o,BASE:s}=ut,a=ie(e,64,"signature"),c=ie(t,void 0,"message"),l=ie(n,32,"publicKey");try{let _=rs(Rt(l)),d=a.subarray(0,32),A=Rt(d);if(!r.isValidNot0(A))return!1;let h=Rt(a.subarray(32,64));if(!o.isValidNot0(h))return!1;let f=os(d,es(_),c),N=s.mulAddUnsafe(h,_,o.neg(f)),{x:I,y:v}=N.toAffine();return!(N.is0()||!In(v)||!r.eql(I,A))}catch{return!1}}var ft=(()=>{let n=r=>(r=r===void 0?Lt(48):r,Go(ie(r,48,"seed"),Tn.n));return Object.freeze({keygen:yr(n,Qo),getPublicKey:Qo,sign:ti,verify:ss,Point:ut,utils:Object.freeze({randomSecretKey:n,taggedHash:mn,lift_x:rs,pointToBytes:es}),lengths:Object.freeze({secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48})})})();var ni="(?<domain>[^\\n]+?) wants you to sign in with your Solana account:\\n",ri="(?<address>[^\\n]+)(?:\\n|$)",oi="(?:\\n(?<statement>[\\S\\s]*?)(?:\\n|$))??",si="(?:\\nURI: (?<uri>[^\\n]+))?",ai="(?:\\nVersion: (?<version>[^\\n]+))?",ii="(?:\\nChain ID: (?<chainId>[^\\n]+))?",ci="(?:\\nNonce: (?<nonce>[^\\n]+))?",li="(?:\\nIssued At: (?<issuedAt>[^\\n]+))?",_i="(?:\\nExpiration Time: (?<expirationTime>[^\\n]+))?",di="(?:\\nNot Before: (?<notBefore>[^\\n]+))?",Ri="(?:\\nRequest ID: (?<requestId>[^\\n]+))?",Ei="(?:\\nResources:(?<resources>(?:\\n- [^\\n]+)*))?",ui=`${si}${ai}${ii}${ci}${li}${_i}${di}${Ri}${Ei}`,Il=new RegExp(`^${ni}${ri}${oi}${ui}\\n*$`);function as(e){let t=`${e.domain} wants you to sign in with your Solana account:
`;t+=`${e.address}`,e.statement&&(t+=`

${e.statement}`);let n=[];if(e.uri&&n.push(`URI: ${e.uri}`),e.version&&n.push(`Version: ${e.version}`),e.chainId&&n.push(`Chain ID: ${e.chainId}`),e.nonce&&n.push(`Nonce: ${e.nonce}`),e.issuedAt&&n.push(`Issued At: ${e.issuedAt}`),e.expirationTime&&n.push(`Expiration Time: ${e.expirationTime}`),e.notBefore&&n.push(`Not Before: ${e.notBefore}`),e.requestId&&n.push(`Request ID: ${e.requestId}`),e.resources){n.push("Resources:");for(let r of e.resources)n.push(`- ${r}`)}return n.length&&(t+=`

${n.join(`
`)}`),t}var y={ERROR_ASSOCIATION_PORT_OUT_OF_RANGE:"ERROR_ASSOCIATION_PORT_OUT_OF_RANGE",ERROR_REFLECTOR_ID_OUT_OF_RANGE:"ERROR_REFLECTOR_ID_OUT_OF_RANGE",ERROR_FORBIDDEN_WALLET_BASE_URL:"ERROR_FORBIDDEN_WALLET_BASE_URL",ERROR_SECURE_CONTEXT_REQUIRED:"ERROR_SECURE_CONTEXT_REQUIRED",ERROR_SESSION_CLOSED:"ERROR_SESSION_CLOSED",ERROR_SESSION_TIMEOUT:"ERROR_SESSION_TIMEOUT",ERROR_WALLET_NOT_FOUND:"ERROR_WALLET_NOT_FOUND",ERROR_INVALID_PROTOCOL_VERSION:"ERROR_INVALID_PROTOCOL_VERSION",ERROR_BROWSER_NOT_SUPPORTED:"ERROR_BROWSER_NOT_SUPPORTED",ERROR_LOOPBACK_ACCESS_BLOCKED:"ERROR_LOOPBACK_ACCESS_BLOCKED",ERROR_ASSOCIATION_CANCELLED:"ERROR_ASSOCIATION_CANCELLED",ERROR_ILLEGAL_TRANSPORT_STATE:"ERROR_ILLEGAL_TRANSPORT_STATE"},w=class extends Error{constructor(...t){let[n,r,o]=t;super(r);u(this,"data");u(this,"code");this.code=n,this.data=o,this.name="SolanaMobileWalletAdapterError"}};var wn=class extends Error{constructor(...t){let[n,r,o,s]=t;super(o);u(this,"data");u(this,"code");u(this,"jsonRpcMessageId");this.code=r,this.data=s,this.jsonRpcMessageId=n,this.name="SolanaMobileWalletAdapterProtocolError"}},xr=20012;function fi(){let e=ft.utils.randomSecretKey();return{privateKey:e,publicKey:Se(ft.getPublicKey(e))}}async function Oi(e){let t=await crypto.subtle.exportKey("raw",e),n=at(new Uint8Array(t));return Se(n)}function Ai(e,t,n,r,o){return JSON.stringify([0,e,t,n,r,o])}function ds(e,t,n,r,o){let s=Ai(e,t,n,r,o);return Se(at(new TextEncoder().encode(s)))}function is(e,t,n,r){let o=Se(ft.getPublicKey(r)),s=Math.floor(Date.now()/1e3),a=ds(o,s,e,n,t);return{id:a,pubkey:o,created_at:s,kind:e,tags:n,content:t,sig:Se(ft.sign(ye(a),r))}}function hi(e){if(ds(e.pubkey,e.created_at,e.kind,e.tags,e.content)!==e.id)return!1;try{return ft.verify(ye(e.sig),ye(e.id),ye(e.pubkey))}catch{return!1}}async function Dt(e,t){let n=await crypto.subtle.exportKey("raw",e),r=await crypto.subtle.sign({hash:"SHA-256",name:"ECDSA"},t,n),o=new Uint8Array(n.byteLength+r.byteLength);return o.set(new Uint8Array(n),0),o.set(new Uint8Array(r),n.byteLength),o}function Si(e){return as(e)}function Ni(e){return co(Si(e)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}var pi="solana:signTransactions",cs="solana:cloneAuthorization";function vr(e,t){return new Proxy({},{get(n,r){return r==="then"?null:(n[r]==null&&(n[r]=async function(o){let{method:s,params:a}=mi(r,o,e),c=await t(s,a);return s==="authorize"&&a.sign_in_payload&&!c.sign_in_result&&(c.sign_in_result=await Ii(a.sign_in_payload,c,t)),Ti(r,c,e)}),n[r])},defineProperty(){return!1},deleteProperty(){return!1}})}function mi(e,t,n){let r=t,o=e.toString().replace(/[A-Z]/g,s=>`_${s.toLowerCase()}`).toLowerCase();switch(e){case"authorize":{let s=r,{chain:a}=s;if(n==="legacy"){switch(a){case"solana:testnet":a="testnet";break;case"solana:devnet":a="devnet";break;case"solana:mainnet":a="mainnet-beta";break;default:a=s.cluster}s.cluster=a,r=s}else{switch(a){case"testnet":case"devnet":a=`solana:${a}`;break;case"mainnet-beta":a="solana:mainnet"}s.chain=a,r=s}}case"reauthorize":{let{auth_token:s,identity:a}=r;if(s)switch(n){case"legacy":o="reauthorize",r={auth_token:s,identity:a};break;default:o="authorize"}break}}return{method:o,params:r}}function Ti(e,t,n){switch(e){case"getCapabilities":{let r=t;switch(n){case"legacy":{let o=[pi];return r.supports_clone_authorization===!0&&o.push(cs),{...r,features:o}}case"v1":return{...r,supports_sign_and_send_transactions:!0,supports_clone_authorization:r.features.includes(cs)}}}}return t}async function Ii(e,t,n){let r=e.domain??window.location.host,o=t.accounts[0].address,s=Ni({...e,domain:r,address:_o(o)}),a=await n("sign_messages",{addresses:[o],payloads:[s]}),c=Ye(a.signed_payloads[0]),l=Ae(c.slice(0,c.length-64)),_=Ae(c.slice(c.length-64));return{address:o,signed_message:l.length==0?s:l,signature:_}}function gi(e){if(e>=4294967296)throw new Error("Outbound sequence number overflow. The maximum sequence number is 32-bytes.");let t=new ArrayBuffer(4);return new DataView(t).setUint32(0,e,!1),new Uint8Array(t)}var wi=12;async function bi(e,t,n){let r=gi(t),o=new Uint8Array(wi);crypto.getRandomValues(o);let s=await crypto.subtle.encrypt(Es(r,o),n,lr(e)),a=new Uint8Array(r.byteLength+o.byteLength+s.byteLength);return a.set(new Uint8Array(r),0),a.set(new Uint8Array(o),r.byteLength),a.set(new Uint8Array(s),r.byteLength+o.byteLength),a}async function Rs(e,t){let n=e.slice(0,4),r=e.slice(4,16),o=e.slice(16),s=await crypto.subtle.decrypt(Es(n,r),t,o);return cr(new Uint8Array(s))}function Es(e,t){return{additionalData:e,iv:t,name:"AES-GCM",tagLength:128}}async function Dr(){return await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},!1,["sign"])}async function Ut(){return await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},!1,["deriveKey","deriveBits"])}function Ci(){return us(49152+Math.floor(Math.random()*16384))}function us(e){if(e<49152||e>65535)throw new w(y.ERROR_ASSOCIATION_PORT_OUT_OF_RANGE,`Association port number must be between 49152 and 65535. ${e} given.`,{port:e});return e}function Ur(e){return e.replace(/[/+=]/g,t=>({"/":"_","+":"-","=":"."})[t])}var yi="solana-wallet";function ls(e){return e.replace(/(^\/+|\/+$)/g,"").split("/")}function Br(e,t){let n=null;if(t){try{n=new URL(t)}catch{}if(n?.protocol!=="https:")throw new w(y.ERROR_FORBIDDEN_WALLET_BASE_URL,"Base URLs supplied by wallets must be valid `https` URLs")}n||(n=new URL(`${yi}:/`));let r=e.startsWith("/")?e:[...ls(n.pathname),...ls(e)].join("/");return new URL(r,n)}async function Li(e,t,n,r=["v1"]){let o=us(t),s=await crypto.subtle.exportKey("raw",e),a=Ct(s),c=Br("v1/associate/local",n);return c.searchParams.set("association",Ur(a)),c.searchParams.set("port",`${o}`),r.forEach(l=>{c.searchParams.set("v",l)}),c}async function xi(e,t,n,r,o=["v1"]){let s=await crypto.subtle.exportKey("raw",e),a=Ct(s),c=Br("v1/associate/remote",r);return c.searchParams.set("association",Ur(a)),c.searchParams.set("reflector",`${t}`),c.searchParams.set("id",`${Ae(n,!0)}`),o.forEach(l=>{c.searchParams.set("v",l)}),c}async function vi(e,t,n,r,o,s=["v1"]){let a=await crypto.subtle.exportKey("raw",e),c=Ct(a),l=Br(`v1/associate/${t}/nostr`,o);return l.searchParams.set("association",Ur(c)),l.searchParams.set("relay",n),l.searchParams.set("pubkey",r),s.forEach(_=>{l.searchParams.set("v",_)}),l}async function Mr(e,t){let n=JSON.stringify(e),r=e.id;return bi(n,r,t)}async function Pr(e,t){let n=await Rs(e,t),r=JSON.parse(n);if(Object.hasOwnProperty.call(r,"error"))throw new wn(r.id,r.error.code,r.error.message);return r}async function Fr(e,t,n){let[r,o]=await Promise.all([crypto.subtle.exportKey("raw",t),crypto.subtle.importKey("raw",e.slice(0,65),{name:"ECDH",namedCurve:"P-256"},!1,[])]),s=await crypto.subtle.deriveBits({name:"ECDH",public:o},n,256),a=await crypto.subtle.importKey("raw",s,"HKDF",!1,["deriveKey"]);return await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(r),info:new Uint8Array},a,{name:"AES-GCM",length:128},!1,["encrypt","decrypt"])}async function Hr(e,t){let n=await Rs(e,t),r=JSON.parse(n),o="legacy";if(Object.hasOwnProperty.call(r,"v"))switch(r.v){case 1:case"1":case"v1":o="v1";break;case"legacy":o="legacy";break;default:throw new w(y.ERROR_INVALID_PROTOCOL_VERSION,`Unknown/unsupported protocol version: ${r.v}`)}return{protocol_version:o}}var gn={Firefox:0,Other:1};function Di(){return navigator.userAgent.indexOf("Firefox/")!==-1?gn.Firefox:gn.Other}function Ui(){return new Promise((e,t)=>{function n(){clearTimeout(o),window.removeEventListener("blur",r)}function r(){n(),e()}window.addEventListener("blur",r);let o=setTimeout(()=>{n(),t()},3e3)})}var Ot=null;function Bi(e){(Ot==null||!Ot.isConnected)&&(Ot=document.createElement("iframe"),Ot.style.display="none",document.body.appendChild(Ot)),Ot.contentWindow.location.href=e.toString()}async function fs(e){if(e.protocol==="https:")window.location.assign(e);else try{switch(Di()){case gn.Firefox:Bi(e);break;case gn.Other:{let t=Ui();window.location.assign(e),await t;break}}}catch{throw new w(y.ERROR_WALLET_NOT_FOUND,"Found no installed wallet that supports the mobile wallet protocol.")}}async function Mi(e,t){let n=Ci();return await fs(await Li(e,n,t)),n}async function Pi(e,t,n,r,o){let s=await vi(e,t,n,r,o);return t=="local"&&await fs(s),s}var At={retryDelayScheduleMs:[150,150,200,500,500,750,750,1e3],timeoutMs:3e4},Fi=3e4,Os="com.solana.mobilewalletadapter.v1",_s="com.solana.mobilewalletadapter.v1.base64";function Gr(){if(typeof window>"u"||window.isSecureContext!==!0)throw new w(y.ERROR_SECURE_CONTEXT_REQUIRED,"The mobile wallet adapter protocol must be used in a secure context (`https`).")}function kr(e){let t;try{t=new URL(e)}catch{throw new w(y.ERROR_FORBIDDEN_WALLET_BASE_URL,"Invalid base URL supplied by wallet")}if(t.protocol!=="https:")throw new w(y.ERROR_FORBIDDEN_WALLET_BASE_URL,"Base URLs supplied by wallets must be valid `https` URLs")}function ht(e){return new DataView(e).getUint32(0,!1)}function Hi(e){let t=new Uint8Array(e),n=e.byteLength,r=10,o=0,s=0,a;do{if(s>=n||s>r)throw new RangeError("Failed to decode varint");a=t[s++],o|=(a&127)<<7*s}while(a>=128);return{value:o,offset:s}}function Gi(e){let{value:t,offset:n}=Hi(e);return new Uint8Array(e.slice(n,n+t))}async function As(e){Gr();let t=await Dr(),n=`ws://localhost:${await Mi(t.publicKey,e?.baseUri)}/solana-wallet`,r,o=(()=>{let A=[...At.retryDelayScheduleMs];return()=>A.length>1?A.shift():A[0]})(),s=1,a=0,c={__type:"disconnected"},l,_=!1,d;return{close:()=>{l.close(),d()},wallet:new Promise((A,h)=>{let f={},N=S=>{for(let m of Object.keys(f)){let x=Number(m),H=f[x];delete f[x],H.reject(S)}},I=async()=>{if(c.__type!=="connecting"){console.warn(`Expected adapter state to be \`connecting\` at the moment the websocket opens. Got \`${c.__type}\`.`);return}l.removeEventListener("open",I);let{associationKeypair:S}=c,m=await Ut();l.send(await Dt(m.publicKey,S.privateKey)),c={__type:"hello_req_sent",associationPublicKey:S.publicKey,ecdhPrivateKey:m.privateKey}},v=S=>{S.wasClean?c={__type:"disconnected"}:h(new w(y.ERROR_SESSION_CLOSED,`The wallet session dropped unexpectedly (${S.code}: ${S.reason}).`,{closeEvent:S})),N(new w(y.ERROR_SESSION_CLOSED,`The wallet session closed before a response was received (${S.code}: ${S.reason}).`,{closeEvent:S})),$()},B=async S=>{N(new w(y.ERROR_SESSION_CLOSED,"The wallet session encountered a transport error before a response was received.",{closeEvent:new CloseEvent("transport error")})),$(),Date.now()-r>=At.timeoutMs?h(new w(y.ERROR_SESSION_TIMEOUT,`Failed to connect to the wallet websocket at ${n}.`)):(await new Promise(m=>{let x=o();z=window.setTimeout(m,x)}),F())},K=async S=>{let m=await S.data.arrayBuffer();switch(c.__type){case"connecting":{if(m.byteLength!==0){h(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while connecting"));return}let x=await Ut();l.send(await Dt(x.publicKey,t.privateKey)),c={__type:"hello_req_sent",associationPublicKey:t.publicKey,ecdhPrivateKey:x.privateKey};break}case"connected":if(m.byteLength===0)break;try{let x=ht(m.slice(0,4));if(x!==a+1)throw new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number");a=x;let H=await Pr(m,c.sharedSecret),q=f[H.id];if(!q)break;delete f[H.id],q.resolve(H.result)}catch(x){if(x instanceof wn){let H=f[x.jsonRpcMessageId];if(!H)break;delete f[x.jsonRpcMessageId],H.reject(x)}else N(x),l.close()}break;case"hello_req_sent":{if(m.byteLength===0){let j=await Ut();l.send(await Dt(j.publicKey,t.privateKey)),c={__type:"hello_req_sent",associationPublicKey:t.publicKey,ecdhPrivateKey:j.privateKey};break}let x=await Fr(m,c.associationPublicKey,c.ecdhPrivateKey),H=m.slice(65),q=H.byteLength!==0?await(async()=>{let j=ht(H.slice(0,4));return j!==a+1?(h(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number")),l.close(),{protocol_version:"v1"}):(a=j,Hr(H,x))})():{protocol_version:"legacy"};c={__type:"connected",sharedSecret:x,sessionProperties:q};let be=vr(q.protocol_version,async(j,te)=>{let Te=s++;return l.send(await Mr({id:Te,jsonrpc:"2.0",method:j,params:te??{}},x)),new Promise((Re,W)=>{f[Te]={resolve(k){switch(j){case"authorize":case"reauthorize":{let{wallet_uri_base:ce}=k;if(ce!=null)try{kr(ce)}catch(Y){W(Y);return}break}}Re(k)},reject:W}})});_=!0;try{A(be)}catch(j){h(j)}break}}};d=()=>{l.removeEventListener("message",K),$(),_||h(new w(y.ERROR_SESSION_CLOSED,"The wallet session was closed before connection.",{closeEvent:new CloseEvent("socket was closed before connection")}))};let $,z,F=()=>{$&&$(),c={__type:"connecting",associationKeypair:t},r===void 0&&(r=Date.now()),l=new WebSocket(n,[Os]),l.addEventListener("open",I),l.addEventListener("close",v),l.addEventListener("error",B),l.addEventListener("message",K),$=()=>{window.clearTimeout(z),l.removeEventListener("open",I),l.removeEventListener("close",v),l.removeEventListener("error",B),l.removeEventListener("message",K)}};F()})}}async function hs(e){Gr();let t=await Dr(),n=`wss://${e?.remoteHostAuthority}/reflect`,r,o=(()=>{let I=[...At.retryDelayScheduleMs];return()=>I.length>1?I.shift():I[0]})(),s=1,a=0,c,l={__type:"disconnected"},_,d,A=async I=>{if(c=="base64"){let v=await I.data;return Ye(v).buffer}else return await I.data.arrayBuffer()},h=await new Promise((I,v)=>{let B=async()=>{if(l.__type!=="connecting"){console.warn(`Expected adapter state to be \`connecting\` at the moment the websocket opens. Got \`${l.__type}\`.`);return}_.protocol.includes(_s)?c="base64":c="binary",_.removeEventListener("open",B)},K=m=>{m.wasClean?l={__type:"disconnected"}:v(new w(y.ERROR_SESSION_CLOSED,`The wallet session dropped unexpectedly (${m.code}: ${m.reason}).`,{closeEvent:m})),d()},$=async m=>{d(),Date.now()-r>=At.timeoutMs?v(new w(y.ERROR_SESSION_TIMEOUT,`Failed to connect to the wallet websocket at ${n}.`)):(await new Promise(x=>{let H=o();F=window.setTimeout(x,H)}),S())},z=async m=>{let x=await A(m);if(l.__type==="connecting"){if(x.byteLength==0){v(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while connecting")),_.close();return}let H=Gi(x);l={__type:"reflector_id_received",reflectorId:H};let q=await xi(t.publicKey,e.remoteHostAuthority,H,e?.baseUri);_.removeEventListener("message",z),I(q)}},F,S=()=>{d&&d(),l={__type:"connecting",associationKeypair:t},r===void 0&&(r=Date.now()),_=new WebSocket(n,[Os,_s]),_.addEventListener("open",B),_.addEventListener("close",K),_.addEventListener("error",$),_.addEventListener("message",z),d=()=>{window.clearTimeout(F),_.removeEventListener("open",B),_.removeEventListener("close",K),_.removeEventListener("error",$),_.removeEventListener("message",z)}};S()}),f=!1,N;return{associationUrl:h,close:()=>{_.close(),N()},wallet:new Promise((I,v)=>{let B={},K=z=>{for(let F of Object.keys(B)){let S=Number(F),m=B[S];delete B[S],m.reject(z)}},$=async z=>{let F=await A(z);switch(l.__type){case"reflector_id_received":{if(F.byteLength!==0){v(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while awaiting reflection")),_.close();return}let S=await Ut(),m=await Dt(S.publicKey,t.privateKey);c=="base64"?_.send(Ae(m)):_.send(m),l={__type:"hello_req_sent",associationPublicKey:t.publicKey,ecdhPrivateKey:S.privateKey};break}case"connected":if(F.byteLength===0)break;try{let S=ht(F.slice(0,4));if(S!==a+1)throw new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number");a=S;let m=await Pr(F,l.sharedSecret),x=B[m.id];if(!x)break;delete B[m.id],x.resolve(m.result)}catch(S){if(S instanceof wn){let m=B[S.jsonRpcMessageId];if(!m)break;delete B[S.jsonRpcMessageId],m.reject(S)}else K(S),_.close()}break;case"hello_req_sent":{let S=await Fr(F,l.associationPublicKey,l.ecdhPrivateKey),m=F.slice(65),x=m.byteLength!==0?await(async()=>{let q=ht(m.slice(0,4));return q!==a+1?(v(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number")),_.close(),{protocol_version:"v1"}):(a=q,Hr(m,S))})():{protocol_version:"legacy"};l={__type:"connected",sharedSecret:S,sessionProperties:x};let H=vr(x.protocol_version,async(q,be)=>{let j=s++,te=await Mr({id:j,jsonrpc:"2.0",method:q,params:be??{}},S);return c=="base64"?_.send(Ae(te)):_.send(te),new Promise((Te,Re)=>{B[j]={resolve(W){switch(q){case"authorize":case"reauthorize":{let{wallet_uri_base:k}=W;if(k!=null)try{kr(k)}catch(ce){Re(ce);return}break}}Te(W)},reject:Re}})});f=!0;try{I(H)}catch(q){v(q)}break}}};_.addEventListener("message",$),_.addEventListener("close",()=>K(new w(y.ERROR_SESSION_CLOSED,"The wallet session closed before a response was received.",{closeEvent:new CloseEvent("session closed")}))),_.addEventListener("error",()=>K(new w(y.ERROR_SESSION_CLOSED,"The wallet session encountered a transport error before a response was received.",{closeEvent:new CloseEvent("transport error")}))),N=()=>{_.removeEventListener("message",$),d(),f||v(new w(y.ERROR_SESSION_CLOSED,"The wallet session was closed before connection.",{closeEvent:new CloseEvent("socket was closed before connection")}))}})}}async function Vr(e){Gr();let t=await Dr(),{privateKey:n,publicKey:r}=fi(),o=await Pi(t.publicKey,e.connectionType,e.relayDomain,r,e.baseUri),s=await Oi(t.publicKey),a=crypto.randomUUID(),c=JSON.stringify(["REQ",a,{kinds:[xr],"#d":[s]}]),l=`wss://${e.relayDomain}`,_=Date.now(),d=(()=>{let z=[...At.retryDelayScheduleMs];return()=>z.length>1?z.shift():z[0]})(),A=1,h=0,f={__type:"disconnected"},N,I=!1,v,B=(z,F)=>{let S=is(xr,z,[["d",s],["p",F]],n);N.send(JSON.stringify(["EVENT",S]))},K=()=>{if(f.__type=="connected"||f.__type=="hello_req_sent"){let z=is(xr,"",[["d",s],["p",f.walletNostrPubkey],["msg","SESSION_END"]],n);N.send(JSON.stringify(["EVENT",z]))}N.close()},$={close:()=>{K(),v()},wallet:new Promise((z,F)=>{let S={},m,x=W=>{for(let k of Object.keys(S)){let ce=Number(k),Y=S[ce];delete S[ce],Y.reject(W)}},H=async()=>{if(f.__type!=="connecting"){console.warn(`Expected adapter state to be \`connecting\` at the moment the websocket opens. Got \`${f.__type}\`.`);return}N.removeEventListener("open",H),N.send(c),m=window.setInterval(()=>{Object.keys(S).length>0&&N.send(c)},Fi),f={__type:"subscribed",dappNostrPrivateKey:n,dappNostrPubkey:r,sessionIdentifier:s}},q=W=>{W.wasClean?f={__type:"disconnected"}:F(new w(y.ERROR_SESSION_CLOSED,`The Nostr subscription dropped unexpectedly (${W.code}: ${W.reason}).`,{closeEvent:W})),x(new w(y.ERROR_SESSION_CLOSED,`The wallet session closed before a response was received (${W.code}: ${W.reason}).`,{closeEvent:W})),te()},be=async()=>{x(new w(y.ERROR_SESSION_CLOSED,"The wallet session encountered a transport error before a response was received.",{closeEvent:new CloseEvent("transport error")})),te(),Date.now()-_>=At.timeoutMs?F(new w(y.ERROR_SESSION_TIMEOUT,`Failed to connect to the Nostr relay at ${e.relayDomain}.`)):(await new Promise(W=>{let k=d();Te=window.setTimeout(W,k)}),Re())},j=async W=>{let k;try{if(k=JSON.parse(W.data),!Array.isArray(k))throw new Error}catch{F(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Invalid Nostr message received: "+W.data)),K();return}let ce=k[0];if(ce==="CLOSED")x(new w(y.ERROR_SESSION_CLOSED,"The Nostr relay closed the session subscription before a response was received.",{closeEvent:new CloseEvent("session closed")})),te();else if(ce==="EVENT"){let Y=k[2];if(!Y||!hi(Y))return;if(Y.pubkey===f.walletNostrPubkey&&Y.tags.some(([b,L])=>b==="msg"&&L==="SESSION_END")){let b=new w(y.ERROR_SESSION_CLOSED,"The wallet ended the session.",{closeEvent:new CloseEvent("session ended by wallet")});F(b),x(b),N.close();return}switch(f.__type){case"subscribed":{if(Y.content.length!==0){F(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while awaiting reflection")),K();return}let b=Y.pubkey,L=await Ut(),E=await Dt(L.publicKey,t.privateKey),O=Ae(E);B(O,b),f={__type:"hello_req_sent",associationPublicKey:t.publicKey,ecdhPrivateKey:L.privateKey,walletNostrPubkey:b};break}case"hello_req_sent":{if(Y.pubkey!==f.walletNostrPubkey||Y.content==="")return;let b=Ye(Y.content).buffer,L=await Fr(b,f.associationPublicKey,f.ecdhPrivateKey),E=b.slice(65),O=E.byteLength!==0?await(async()=>{let T=ht(E.slice(0,4));return T!==h+1?(F(new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number")),K(),{protocol_version:"v1"}):(h=T,Hr(E,L))})():{protocol_version:"legacy"};f={__type:"connected",sharedSecret:L,sessionProperties:O,walletNostrPubkey:f.walletNostrPubkey};let p=vr(O.protocol_version,async(T,D)=>{let C=A++,M=await Mr({id:C,jsonrpc:"2.0",method:T,params:D??{}},L);return B(Ae(M),f.walletNostrPubkey),new Promise((U,V)=>{S[C]={resolve(P){switch(T){case"authorize":case"reauthorize":{let{wallet_uri_base:Z}=P;if(Z!=null)try{kr(Z)}catch(se){V(se);return}break}}U(P)},reject:V}})});I=!0;try{z(p)}catch(T){F(T)}break}case"connected":if(Y.pubkey!==f.walletNostrPubkey||Y.content==="")return;try{let b=Ye(Y.content).buffer,L=ht(b.slice(0,4));if(L!==h+1)throw new w(y.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number");h=L;let E=await Pr(b,f.sharedSecret),O=S[E.id];if(!O)break;delete S[E.id],O.resolve(E.result)}catch(b){if(b instanceof wn){let L=S[b.jsonRpcMessageId];if(!L)break;delete S[b.jsonRpcMessageId],L.reject(b)}else x(b),K()}}}};v=()=>{N.removeEventListener("message",j),te(),x(new w(y.ERROR_SESSION_CLOSED,"The wallet session was closed before a response was received.",{closeEvent:new CloseEvent("session closed")})),I||F(new w(y.ERROR_SESSION_CLOSED,"The wallet session was closed before connection.",{closeEvent:new CloseEvent("socket was closed before connection")}))};let te,Te,Re=()=>{te&&te(),f={__type:"connecting",associationKeypair:t},N=new WebSocket(l),N.addEventListener("open",H),N.addEventListener("close",q),N.addEventListener("error",be),N.addEventListener("message",j),te=()=>{window.clearInterval(m),window.clearTimeout(Te),N.removeEventListener("open",H),N.removeEventListener("close",q),N.removeEventListener("error",be),N.removeEventListener("message",j)}};Re()})};return e.connectionType=="local"?$:{...$,associationUrl:o}}var Ne="solana:signAndSendTransaction";var bn="solana:signIn";var Cn="solana:signMessage";var pe="solana:signTransaction";var zr="standard:connect";var Kr="standard:disconnect";var Wr="standard:events";var Ss={toCanvas(){throw new Error("no QR codes here: the remote mode is left out of this build")}};var Yr="SolanaMobileWalletAdapterDefaultAuthorizationCache";function tr(){let e;try{e=window.localStorage}catch{}return{async clear(){if(e)try{e.removeItem(Yr)}catch{}},async get(){if(e)try{let t=JSON.parse(e.getItem(Yr));if(t&&t.accounts){let n=t.accounts.map(r=>({...r,publicKey:"publicKey"in r?new Uint8Array(Object.values(r.publicKey)):ir(r.address)}));return{...t,accounts:n}}else return t||void 0}catch{}},async set(t){if(e)try{e.setItem(Yr,JSON.stringify(t))}catch{}}}}function Cs(){return{async select(e){return e.length===1?e[0]:e.includes(_r)?_r:e[0]}}}var ki=`
<div class="mobile-wallet-adapter-embedded-modal-container" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div data-modal-close style="position: absolute; width: 100%; height: 100%;"></div>
	<div class="mobile-wallet-adapter-embedded-modal-card">
		<div>
			<button data-modal-close class="mobile-wallet-adapter-embedded-modal-close">
				<svg width="14" height="14">
					<path d="M 6.7125,8.3036995 1.9082,13.108199 c -0.2113,0.2112 -0.4765,0.3168 -0.7957,0.3168 -0.3192,0 -0.5844,-0.1056 -0.7958,-0.3168 C 0.1056,12.896899 0,12.631699 0,12.312499 c 0,-0.3192 0.1056,-0.5844 0.3167,-0.7958 L 5.1212,6.7124995 0.3167,1.9082 C 0.1056,1.6969 0,1.4317 0,1.1125 0,0.7933 0.1056,0.5281 0.3167,0.3167 0.5281,0.1056 0.7933,0 1.1125,0 1.4317,0 1.6969,0.1056 1.9082,0.3167 L 6.7125,5.1212 11.5167,0.3167 C 11.7281,0.1056 11.9933,0 12.3125,0 c 0.3192,0 0.5844,0.1056 0.7957,0.3167 0.2112,0.2114 0.3168,0.4766 0.3168,0.7958 0,0.3192 -0.1056,0.5844 -0.3168,0.7957 L 8.3037001,6.7124995 13.1082,11.516699 c 0.2112,0.2114 0.3168,0.4766 0.3168,0.7958 0,0.3192 -0.1056,0.5844 -0.3168,0.7957 -0.2113,0.2112 -0.4765,0.3168 -0.7957,0.3168 -0.3192,0 -0.5844,-0.1056 -0.7958,-0.3168 z" />
				</svg>
			</button>
		</div>
		<div class="mobile-wallet-adapter-embedded-modal-content"></div>
	</div>
</div>
`,Vi=`
.mobile-wallet-adapter-embedded-modal-container {
    display: flex; /* Use flexbox to center content */
    justify-content: center; /* Center horizontally */
    align-items: center; /* Center vertically */
    position: fixed; /* Stay in place */
    z-index: 2147483647; /* Sit on top */
    left: 0;
    top: 0;
    width: 100%; /* Full width */
    height: 100%; /* Full height */
    background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
    overflow-y: auto; /* enable scrolling */
}

.mobile-wallet-adapter-embedded-modal-card {
    display: flex;
    flex-direction: column;
    margin: auto 20px;
    max-width: 780px;
    padding: 20px;
    border-radius: 24px;
    background: #ffffff;
    font-family: "Inter Tight", "PT Sans", Calibri, sans-serif;
    transform: translateY(-200%);
    animation: slide-in 0.5s forwards;
}

@keyframes slide-in {
    100% { transform: translateY(0%); }
}

.mobile-wallet-adapter-embedded-modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    cursor: pointer;
    background: #e4e9e9;
    border: none;
    border-radius: 50%;
}

.mobile-wallet-adapter-embedded-modal-close:focus-visible {
    outline-color: red;
}

.mobile-wallet-adapter-embedded-modal-close svg {
    fill: #546266;
    transition: fill 200ms ease 0s;
}

.mobile-wallet-adapter-embedded-modal-close:hover svg {
    fill: #fff;
}
`,zi=`

`,X,Be,Xe,ze,ys,Ls,xs,Bt,ps,en=(ps=class{constructor(){R(this,ze);R(this,X,null);R(this,Be,{});R(this,Xe,!1);u(this,"dom",null);u(this,"open",()=>{console.debug("Modal open"),J(this,ze,Ls).call(this),i(this,X)&&(i(this,X).style.display="flex")});u(this,"close",(e=void 0)=>{console.debug("Modal close"),J(this,ze,xs).call(this),i(this,X)&&(i(this,X).style.display="none"),i(this,Be).close?.forEach(t=>t(e))});R(this,Bt,e=>{e.key==="Escape"&&this.close(e)});this.init=this.init.bind(this),g(this,X,document.getElementById("mobile-wallet-adapter-embedded-root-ui"))}async init(){console.log("Injecting modal"),J(this,ze,ys).call(this)}addEventListener(e,t){return i(this,Be)[e]?.push(t)||(i(this,Be)[e]=[t]),()=>this.removeEventListener(e,t)}removeEventListener(e,t){i(this,Be)[e]=i(this,Be)[e]?.filter(n=>t!==n)}},X=new WeakMap,Be=new WeakMap,Xe=new WeakMap,ze=new WeakSet,ys=function(){if(document.getElementById("mobile-wallet-adapter-embedded-root-ui")){i(this,X)||g(this,X,document.getElementById("mobile-wallet-adapter-embedded-root-ui"));return}g(this,X,document.createElement("div")),i(this,X).id="mobile-wallet-adapter-embedded-root-ui",i(this,X).innerHTML=ki,i(this,X).style.display="none";let e=i(this,X).querySelector(".mobile-wallet-adapter-embedded-modal-content");e&&(e.innerHTML=this.contentHtml);let t=document.createElement("style");t.id="mobile-wallet-adapter-embedded-modal-styles",t.textContent=Vi+this.contentStyles;let n=document.createElement("div");n.innerHTML=zi,this.dom=n.attachShadow({mode:"closed"}),this.dom.appendChild(t),this.dom.appendChild(i(this,X)),document.body.appendChild(n)},Ls=function(){!i(this,X)||i(this,Xe)||([...i(this,X).querySelectorAll("[data-modal-close]")].forEach(e=>e?.addEventListener("click",this.close)),window.addEventListener("load",this.close),document.addEventListener("keydown",i(this,Bt)),g(this,Xe,!0))},xs=function(){i(this,Xe)&&(window.removeEventListener("load",this.close),document.removeEventListener("keydown",i(this,Bt)),i(this,X)&&([...i(this,X).querySelectorAll("[data-modal-close]")].forEach(e=>e?.removeEventListener("click",this.close)),g(this,Xe,!1)))},Bt=new WeakMap,ps),Ki="To use mobile wallet adapter, you must have a compatible mobile wallet application installed on your device.",Wi="This browser appears to be incompatible with mobile wallet adapter. Open this page in a compatible mobile browser app and try again.",Yi=class extends en{constructor(){super(...arguments);u(this,"contentStyles",qi);u(this,"contentHtml",ji)}initWithError(t){super.init(),this.populateError(t)}populateError(t){let n=this.dom?.getElementById("mobile-wallet-adapter-error-message"),r=this.dom?.getElementById("mobile-wallet-adapter-error-action");if(n){if(t.name==="SolanaMobileWalletAdapterError")switch(t.code){case"ERROR_WALLET_NOT_FOUND":n.innerHTML=Ki,r&&r.addEventListener("click",()=>{window.location.href="https://solanamobile.com/wallets"});return;case"ERROR_BROWSER_NOT_SUPPORTED":n.innerHTML=Wi,r&&(r.style.display="none");return}n.innerHTML=`An unexpected error occurred: ${t.message}`}else console.log("Failed to locate error dialog element")}},ji=`
<svg class="mobile-wallet-adapter-embedded-modal-error-icon" xmlns="http://www.w3.org/2000/svg" height="50px" viewBox="0 -960 960 960" width="50px" fill="#000000"><path d="M 280,-80 Q 197,-80 138.5,-138.5 80,-197 80,-280 80,-363 138.5,-421.5 197,-480 280,-480 q 83,0 141.5,58.5 58.5,58.5 58.5,141.5 0,83 -58.5,141.5 Q 363,-80 280,-80 Z M 824,-120 568,-376 Q 556,-389 542.5,-402.5 529,-416 516,-428 q 38,-24 61,-64 23,-40 23,-88 0,-75 -52.5,-127.5 Q 495,-760 420,-760 345,-760 292.5,-707.5 240,-655 240,-580 q 0,6 0.5,11.5 0.5,5.5 1.5,11.5 -18,2 -39.5,8 -21.5,6 -38.5,14 -2,-11 -3,-22 -1,-11 -1,-23 0,-109 75.5,-184.5 Q 311,-840 420,-840 q 109,0 184.5,75.5 75.5,75.5 75.5,184.5 0,43 -13.5,81.5 Q 653,-460 629,-428 l 251,252 z m -615,-61 71,-71 70,71 29,-28 -71,-71 71,-71 -28,-28 -71,71 -71,-71 -28,28 71,71 -71,71 z"/></svg>
<div class="mobile-wallet-adapter-embedded-modal-title">We can't find a wallet.</div>
<div id="mobile-wallet-adapter-error-message" class="mobile-wallet-adapter-embedded-modal-subtitle"></div>
<div>
    <button data-error-action id="mobile-wallet-adapter-error-action" class="mobile-wallet-adapter-embedded-modal-error-action">
        Find a wallet
    </button>
</div>
`,qi=`
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}

.mobile-wallet-adapter-embedded-modal-error-icon {
    margin-top: 24px;
}

.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}

.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 30px 60px 40px 60px;
    color: #000000;
    font-size: 1.25em;
    font-weight: 400;
}

.mobile-wallet-adapter-embedded-modal-error-action {
    display: block;
    width: 100%;
    height: 56px;
    /*margin-top: 40px;*/
    font-size: 1.25em;
    /*line-height: 24px;*/
    /*letter-spacing: -1%;*/
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}

/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`;async function Xi(){if(typeof window<"u"){let e=window.navigator.userAgent.toLowerCase(),t=new Yi;e.includes("wv")?t.initWithError({name:"SolanaMobileWalletAdapterError",code:"ERROR_BROWSER_NOT_SUPPORTED",message:""}):t.initWithError({name:"SolanaMobileWalletAdapterError",code:"ERROR_WALLET_NOT_FOUND",message:""}),t.open()}}function vs(){return async()=>{Xi()}}var xn,Ds,ms,$i=(ms=class extends en{constructor(){super(...arguments);R(this,xn);u(this,"contentStyles",Ji);u(this,"contentHtml",Zi)}initWithCallback(t){super.init(),J(this,xn,Ds).call(this,t)}},xn=new WeakSet,Ds=function(t){let n=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),r=async()=>{n?.removeEventListener("click",r),this.close(),t()};n?.addEventListener("click",r)},ms),Zi=`
<svg class="mobile-wallet-adapter-embedded-modal-launch-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21.6 48C7.2 48 0 40.8 0 26.4V21.6C0 7.2 7.2 0 21.6 0H26.4C40.8 0 48 7.2 48 21.6V26.4C48 40.8 40.8 48 26.4 48H21.6Z" fill="#15994E"/>
    <mask id="mask0_189_522" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
        <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
    </mask>
    <g mask="url(#mask0_189_522)">
        <mask id="mask1_189_522" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
            <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
        </mask>
        <g mask="url(#mask1_189_522)">
            <path d="M22.1092 26.1208L19.4498 23.4615C19.1736 23.1851 18.8253 23.0468 18.4048 23.0468C17.9846 23.0468 17.6363 23.1851 17.3598 23.4615C17.0836 23.7377 16.9468 24.0861 16.9495 24.5065C16.9522 24.9267 17.0916 25.275 17.3678 25.5512L21.0405 29.2238C21.3463 29.5276 21.7031 29.6795 22.1108 29.6795C22.5184 29.6795 22.8742 29.5276 23.1782 29.2238L30.5918 21.8098C30.8683 21.5336 31.0065 21.1867 31.0065 20.7692C31.0065 20.3514 30.8683 20.0044 30.5918 19.7282C30.3156 19.4517 29.9673 19.3135 29.5468 19.3135C29.1266 19.3135 28.7784 19.4517 28.5022 19.7282L22.1092 26.1208ZM23.9998 37.6042C22.113 37.6042 20.3425 37.2473 18.6885 36.5335C17.0343 35.8197 15.5954 34.8512 14.3718 33.6278C13.1485 32.4043 12.18 30.9654 11.4662 29.3112C10.7524 27.6572 10.3955 25.8867 10.3955 23.9998C10.3955 22.113 10.7524 20.3425 11.4662 18.6885C12.18 17.0343 13.1485 15.5954 14.3718 14.3718C15.5954 13.1485 17.0343 12.18 18.6885 11.4662C20.3425 10.7524 22.113 10.3955 23.9998 10.3955C25.8867 10.3955 27.6572 10.7524 29.3112 11.4662C30.9654 12.18 32.4043 13.1485 33.6278 14.3718C34.8512 15.5954 35.8197 17.0343 36.5335 18.6885C37.2473 20.3425 37.6042 22.113 37.6042 23.9998C37.6042 25.8867 37.2473 27.6572 36.5335 29.3112C35.8197 30.9654 34.8512 32.4043 33.6278 33.6278C32.4043 34.8512 30.9654 35.8197 29.3112 36.5335C27.6572 37.2473 25.8867 37.6042 23.9998 37.6042Z" fill="white"/>
        </g>
    </g>
</svg>
<div class="mobile-wallet-adapter-embedded-modal-title">Ready to connect!</div>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Connect Wallet
    </button>
</div>
`,Ji=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
    min-width: 300px;
}
.mobile-wallet-adapter-embedded-modal-launch-icon {
    margin-top: 24px;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px 30px 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    font-size: 1.25em;
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
}
`,vn,Us,Ts,Qi=(Ts=class extends en{constructor(){super(...arguments);R(this,vn);u(this,"contentStyles",tc)}get contentHtml(){let t=cc()?"Long press the app icon on your home screen to open site settings":"Tap the lock or settings icon in the address bar to open site settings";return ec.replace("{{PERMISSION_INSTRUCTION_DETAIL}}",t)}async init(){super.init(),J(this,vn,Us).call(this)}},vn=new WeakSet,Us=function(){let t=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),n=async r=>{t?.removeEventListener("click",n),this.close(r)};t?.addEventListener("click",n)},Ts),ec=`
<div class="mobile-wallet-adapter-embedded-modal-header">
    Local Wallet Connection
</div>
<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21.6 48C7.2 48 0 40.8 0 26.4V21.6C0 7.2 7.2 0 21.6 0H26.4C40.8 0 48 7.2 48 21.6V26.4C48 40.8 40.8 48 26.4 48H21.6Z" fill="#ED1515"/>
    <mask id="mask0_147_1364" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
        <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
    </mask>
    <g mask="url(#mask0_147_1364)">
        <path d="M20.1398 36.2705C19.7363 36.2705 19.3508 36.1945 18.9835 36.0425C18.6162 35.8907 18.2916 35.674 18.0098 35.3922L12.6072 29.9895C12.3254 29.7077 12.1086 29.3832 11.9568 29.0158C11.8048 28.6485 11.7288 28.2631 11.7288 27.8595V20.1395C11.7288 19.736 11.8048 19.3505 11.9568 18.9832C12.1086 18.6158 12.3254 18.2913 12.6072 18.0095L18.0098 12.6068C18.2916 12.3251 18.6162 12.1083 18.9835 11.9565C19.3508 11.8045 19.7363 11.7285 20.1398 11.7285H27.8598C28.2634 11.7285 28.6488 11.8045 29.0162 11.9565C29.3835 12.1083 29.708 12.3251 29.9898 12.6068L35.3925 18.0095C35.6743 18.2913 35.891 18.6158 36.0428 18.9832C36.1948 19.3505 36.2708 19.736 36.2708 20.1395V27.8595C36.2708 28.2631 36.1948 28.6485 36.0428 29.0158C35.891 29.3832 35.6743 29.7077 35.3925 29.9895L29.9898 35.3922C29.708 35.674 29.3835 35.8907 29.0162 36.0425C28.6488 36.1945 28.2634 36.2705 27.8598 36.2705H20.1398ZM20.1732 33.2372H27.8265L33.2375 27.8262V20.1728L27.8265 14.7618H20.1732L14.7622 20.1728V27.8262L20.1732 33.2372ZM23.9998 25.9538L26.7868 28.7408C27.0473 29.0013 27.3729 29.1302 27.7638 29.1275C28.1549 29.1248 28.4807 28.9933 28.7412 28.7328C29.0016 28.4724 29.1318 28.1466 29.1318 27.7555C29.1318 27.3646 29.0016 27.039 28.7412 26.7785L25.9542 23.9995L28.7412 21.2125C29.0016 20.9521 29.1318 20.6264 29.1318 20.2355C29.1318 19.8444 29.0016 19.5186 28.7412 19.2582C28.4807 18.9977 28.1549 18.8675 27.7638 18.8675C27.3729 18.8675 27.0473 18.9977 26.7868 19.2582L23.9998 22.0452L21.2128 19.2582C20.9524 18.9977 20.628 18.8675 20.2398 18.8675C19.8514 18.8675 19.5269 18.9977 19.2665 19.2582C19.006 19.5186 18.8758 19.8444 18.8758 20.2355C18.8758 20.6264 19.006 20.9521 19.2665 21.2125L22.0455 23.9995L19.2585 26.7865C18.998 27.047 18.8692 27.3713 18.8718 27.7595C18.8745 28.148 19.006 28.4724 19.2665 28.7328C19.5269 28.9933 19.8527 29.1235 20.2438 29.1235C20.6347 29.1235 20.9604 28.9933 21.2208 28.7328L23.9998 25.9538Z" fill="black"/>
    </g>
</svg>
<div class="mobile-wallet-adapter-embedded-modal-title">
    Your wallet connection is blocked
</div>
<div id="mobile-wallet-adapter-local-launch-message" class="mobile-wallet-adapter-embedded-modal-subtitle">
    Visit site settings in the address bar and allow "Apps on Device".
</div>

<div class="mobile-wallet-adapter-embedded-modal-divider"><hr></div>
<div class="mobile-wallet-adapter-embedded-modal-footer">
    <div class="mobile-wallet-adapter-embedded-modal-details">
        <!-- Clickable header (label associated with the checkbox) -->
      	<label for="collapsible-1" class="mobile-wallet-adapter-embedded-modal-details-collapsible-header">
            <!-- Hidden checkbox to track state -->
            <input type="checkbox" id="collapsible-1" class="mobile-wallet-adapter-embedded-modal-details-collapsible-input">
            <span class="mobile-wallet-adapter-embedded-modal-details-collapsible-header-label">
              See details
            </span>
            <svg class="mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <mask id="mask0_147_1382" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="#D9D9D9"/>
              </mask>
              <g mask="url(#mask0_147_1382)">
                <path d="M11.9999 17.0811C11.8506 17.0811 11.7087 17.0563 11.5741 17.0067C11.4395 16.957 11.3162 16.8762 11.2042 16.7643L6.57924 12.1393C6.36801 11.9281 6.26656 11.667 6.27489 11.3561C6.28322 11.0453 6.39301 10.7842 6.60424 10.573C6.81547 10.3618 7.08069 10.2561 7.39989 10.2561C7.71909 10.2561 7.9843 10.3618 8.19554 10.573L11.9999 14.3773L15.8292 10.548C16.0405 10.3368 16.3015 10.2353 16.6124 10.2436C16.9233 10.252 17.1843 10.3618 17.3955 10.573C17.6068 10.7842 17.7124 11.0494 17.7124 11.3686C17.7124 11.6878 17.6068 11.9531 17.3955 12.1643L12.7955 16.7643C12.6836 16.8762 12.5603 16.957 12.4257 17.0067C12.2911 17.0563 12.1492 17.0811 11.9999 17.0811Z" fill="black"/>
              </g>
            </svg>
      	</label>
        
        <!-- Content to show/hide -->
        <ul class="mobile-wallet-adapter-embedded-modal-details-collapsible-content">
            <li>{{PERMISSION_INSTRUCTION_DETAIL}}</li>
            <li>Allow "Apps on Device"</li>
        </ul>
    </div>
</div>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Got it
    </button>
</div>
`,tc=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}
.mobile-wallet-adapter-embedded-modal-header {
    margin: 18px auto 30px auto;
    color: #7D9093;
    font-size: 1.0em;
    font-weight: 500;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 12px 60px 30px 60px;
    color: #7D9093;
    font-size: 1.25em;
    font-weight: 400;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header {
    display: flex;
    flex-direction: row;
  	justify-content: space-between;
    margin: 10px auto 10px auto;
    color: #000000;
    font-size: 1.5em;
    font-weight: 600;
    cursor: pointer; /* Show pointer on hover */
    transition: background 0.2s ease; /* Smooth background change */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon {
  	transition: rotate 0.3s ease;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-input {
  	display: none; /* Hide the checkbox */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-content {
    margin: 0px auto 40px auto;
    max-height: 0px; /* Collapse content */
    overflow: hidden; /* Hide overflow when collapsed */
    transition: max-height 0.3s ease; /* Smooth transition */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-content li {
    margin: 20px auto;
    color: #000000;
    font-size: 1.25em;
    font-weight: 400;
    text-align: left;
}
/* When checkbox is checked, show content */
.mobile-wallet-adapter-embedded-modal-details-collapsible-header:has(> input:checked) ~ .mobile-wallet-adapter-embedded-modal-details-collapsible-content {
  	max-height: 300px;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header:has(> input:checked) > .mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon {
  	rotate: 180deg;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    /*margin-top: 40px;*/
    font-size: 1.25em;
    /*line-height: 24px;*/
    /*letter-spacing: -1%;*/
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.75em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`,Dn,Bs,Is,nc=(Is=class extends en{constructor(){super(...arguments);R(this,Dn);u(this,"contentStyles",oc);u(this,"contentHtml",rc)}async init(){super.init(),J(this,Dn,Bs).call(this)}},Dn=new WeakSet,Bs=function(){let t=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),n=async()=>{t?.removeEventListener("click",n);try{await fetch("http://localhost")}catch{}this.close()};t?.addEventListener("click",n)},Is),rc=`
<div class="mobile-wallet-adapter-embedded-modal-title">Allow connections to your wallet</div>
<div id="mobile-wallet-adapter-local-launch-message" class="mobile-wallet-adapter-embedded-modal-subtitle">
    Tap "Allow" on the next screen
</div>
<svg class="mobile-wallet-adapter-embedded-modal-permission-prompt-mock" xmlns="http://www.w3.org/2000/svg" width="281" height="83" viewBox="0 0 281 83" fill="none">
    <rect width="281" height="83" rx="22" fill="#F0F3F5"/>
    <path d="M254.194 64L252.626 56.657H254.047L254.866 61.452L254.985 62.278H255.02L255.146 61.452L255.993 57.497H257.4L258.254 61.431L258.373 62.278H258.415L258.534 61.431L259.346 56.657H260.718L259.143 64H257.673L256.826 59.961L256.693 59.093H256.651L256.511 59.961L255.664 64H254.194Z" fill="black"/>
    <path d="M248.837 64.231C248.147 64.231 247.54 64.07 247.017 63.748C246.495 63.426 246.086 62.978 245.792 62.404C245.498 61.83 245.351 61.1673 245.351 60.416V60.241C245.351 59.4897 245.498 58.827 245.792 58.253C246.086 57.679 246.495 57.2333 247.017 56.916C247.54 56.594 248.147 56.433 248.837 56.433C249.528 56.433 250.135 56.594 250.657 56.916C251.18 57.2333 251.588 57.679 251.882 58.253C252.176 58.827 252.323 59.4897 252.323 60.241V60.416C252.323 61.1673 252.176 61.83 251.882 62.404C251.588 62.978 251.18 63.426 250.657 63.748C250.135 64.07 249.528 64.231 248.837 64.231ZM248.837 62.824C249.43 62.824 249.897 62.607 250.237 62.173C250.583 61.7343 250.755 61.1417 250.755 60.395V60.262C250.755 59.5107 250.583 58.918 250.237 58.484C249.897 58.05 249.43 57.833 248.837 57.833C248.249 57.833 247.783 58.05 247.437 58.484C247.092 58.918 246.919 59.5107 246.919 60.262V60.395C246.919 61.1417 247.092 61.7343 247.437 62.173C247.783 62.607 248.249 62.824 248.837 62.824Z" fill="black"/>
    <path d="M242.298 64.231C241.467 64.231 240.814 63.993 240.338 63.517C239.866 63.0364 239.631 62.3737 239.631 61.529V53.78H241.178V61.389C241.178 62.3317 241.591 62.803 242.417 62.803C242.65 62.803 242.865 62.7587 243.061 62.67C243.257 62.5814 243.464 62.4367 243.684 62.236L244.538 63.377C244.225 63.6664 243.884 63.881 243.516 64.021C243.152 64.161 242.746 64.231 242.298 64.231ZM237.51 55.061V53.78H240.611V55.061H237.51Z" fill="black"/>
    <path d="M234.463 64.231C233.633 64.231 232.979 63.993 232.503 63.517C232.032 63.0364 231.796 62.3737 231.796 61.529V53.78H233.343V61.389C233.343 62.3317 233.756 62.803 234.582 62.803C234.816 62.803 235.03 62.7587 235.226 62.67C235.422 62.5814 235.63 62.4367 235.849 62.236L236.703 63.377C236.391 63.6664 236.05 63.881 235.681 64.021C235.317 64.161 234.911 64.231 234.463 64.231ZM229.675 55.061V53.78H232.776V55.061H229.675Z" fill="black"/>
    <path d="M221.442 64L224.557 53.976H226.132L229.233 64H227.581L225.642 56.972L225.341 55.761H225.299L225.005 56.972L223.073 64H221.442ZM222.835 61.634L223.255 60.29H227.371L227.805 61.634H222.835Z" fill="black"/>
    <path d="M178.261 64L175.034 60.066V60.024L178.121 56.657H180.011L176.504 60.423V59.632L180.165 64H178.261ZM173.543 64V53.78H175.097V64H173.543Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M169.306 64.224C168.588 64.224 167.958 64.0653 167.416 63.748C166.88 63.426 166.462 62.9803 166.163 62.411C165.865 61.837 165.715 61.1673 165.715 60.402V60.248C165.715 59.4873 165.862 58.8223 166.156 58.253C166.45 57.679 166.863 57.2333 167.395 56.916C167.927 56.594 168.546 56.433 169.25 56.433C169.978 56.433 170.59 56.6056 171.084 56.951C171.579 57.2917 171.955 57.777 172.211 58.407L170.874 58.995C170.72 58.6123 170.508 58.323 170.237 58.127C169.967 57.9263 169.633 57.826 169.236 57.826C168.63 57.826 168.149 58.0383 167.794 58.463C167.444 58.883 167.269 59.4616 167.269 60.199V60.465C167.269 61.1837 167.454 61.7577 167.822 62.187C168.196 62.6163 168.69 62.831 169.306 62.831C169.712 62.831 170.06 62.733 170.349 62.537C170.639 62.341 170.877 62.0423 171.063 61.641L172.379 62.285C172.188 62.6957 171.941 63.0457 171.637 63.335C171.334 63.6243 170.986 63.846 170.594 64C170.202 64.1493 169.773 64.224 169.306 64.224Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M161.003 64.231C160.312 64.231 159.706 64.07 159.183 63.748C158.66 63.426 158.252 62.978 157.958 62.404C157.664 61.83 157.517 61.1673 157.517 60.416V60.241C157.517 59.4897 157.664 58.827 157.958 58.253C158.252 57.679 158.66 57.2333 159.183 56.916C159.706 56.594 160.312 56.433 161.003 56.433C161.694 56.433 162.3 56.594 162.823 56.916C163.346 57.2333 163.754 57.679 164.048 58.253C164.342 58.827 164.489 59.4897 164.489 60.241V60.416C164.489 61.1673 164.342 61.83 164.048 62.404C163.754 62.978 163.346 63.426 162.823 63.748C162.3 64.07 161.694 64.231 161.003 64.231ZM161.003 62.824C161.596 62.824 162.062 62.607 162.403 62.173C162.748 61.7343 162.921 61.1417 162.921 60.395V60.262C162.921 59.5107 162.748 58.918 162.403 58.484C162.062 58.05 161.596 57.833 161.003 57.833C160.415 57.833 159.948 58.05 159.603 58.484C159.258 58.918 159.085 59.5107 159.085 60.262V60.395C159.085 61.1417 159.258 61.7343 159.603 62.173C159.948 62.607 160.415 62.824 161.003 62.824Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M154.463 64.231C153.633 64.231 152.979 63.993 152.503 63.517C152.032 63.0364 151.796 62.3737 151.796 61.529V53.78H153.343V61.389C153.343 62.3317 153.756 62.803 154.582 62.803C154.816 62.803 155.03 62.7587 155.226 62.67C155.422 62.5814 155.63 62.4367 155.849 62.236L156.703 63.377C156.391 63.6664 156.05 63.881 155.681 64.021C155.317 64.161 154.911 64.231 154.463 64.231ZM149.675 55.061V53.78H152.776V55.061H149.675Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M142.24 64V53.976H145.544C146.421 53.976 147.112 54.1953 147.616 54.634C148.12 55.0726 148.372 55.6583 148.372 56.391V56.566C148.372 57.0886 148.246 57.5366 147.994 57.91C147.742 58.2833 147.38 58.5586 146.909 58.736V58.792C147.492 58.9226 147.947 59.2003 148.274 59.625C148.605 60.045 148.771 60.5606 148.771 61.172V61.361C148.771 61.893 148.645 62.3573 148.393 62.754C148.145 63.1506 147.795 63.4586 147.343 63.678C146.895 63.8926 146.365 64 145.754 64H142.24ZM143.794 62.656H145.572C146.085 62.656 146.482 62.5253 146.762 62.264C147.042 62.0026 147.182 61.6293 147.182 61.144V60.99C147.182 60.5046 147.037 60.1313 146.748 59.87C146.463 59.604 146.05 59.471 145.509 59.471H143.36V58.183H145.32C145.791 58.183 146.153 58.064 146.405 57.826C146.657 57.588 146.783 57.2496 146.783 56.811V56.685C146.783 56.2416 146.657 55.9033 146.405 55.67C146.157 55.4366 145.796 55.32 145.32 55.32H143.794V62.656Z" fill="#7D9093" fill-opacity="0.5"/>
    <rect x="18" y="17" width="246" height="7" rx="3.5" fill="#7D9093" fill-opacity="0.26"/>
    <rect x="18" y="33" width="82" height="7" rx="3.5" fill="#7D9093" fill-opacity="0.26"/>
</svg>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Continue to Allow
    </button>
</div>
`,oc=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 20px 60px 40px 60px;
    color: #7D9093;
    font-size: 1.25em;
    font-weight: 400;
}
.mobile-wallet-adapter-embedded-modal-permission-prompt-mock {
    width: 90%;
    height: auto;
    margin: 0 auto 30px auto;
    display: block;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    font-size: 1.25em;
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`;function sc(){return typeof window<"u"&&window.isSecureContext&&typeof document<"u"&&/android/i.test(navigator.userAgent)}function ac(){return typeof window<"u"&&window.isSecureContext&&typeof document<"u"&&!/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)}function ic(e){return/(WebView|Version\/.+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)|; wv\).+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))/i.test(e)}function jr(e){return e.includes("Solana Mobile Web Shell")}function cc(){let e=typeof document<"u"&&document.referrer.startsWith("android-app://");if(typeof window>"u")return e;let t=window.matchMedia("(display-mode: standalone)").matches,n=window.matchMedia("(display-mode: fullscreen)").matches,r=window.matchMedia("(display-mode: minimal-ui)").matches;return e||t||n||r}function lc(e){return e==="localhost"||e.endsWith(".localhost")||e==="[::1]"||/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(e)}function Ms(){return typeof window<"u"&&!!window.location&&lc(window.location.hostname)}async function _c(){if(typeof navigator<"u"&&jr(navigator.userAgent)||Ms())return!0;try{return(await navigator.permissions.query({name:"loopback-network"})).state==="granted"}catch(e){return!!(e instanceof TypeError&&(e.message.includes("loopback-network")||e.message.includes("local-network-access")))}}async function Ps(){if(!(typeof navigator<"u"&&jr(navigator.userAgent))&&!Ms())try{let e=await navigator.permissions.query({name:"loopback-network"});if(e.state==="granted")return;if(e.state==="denied"){let t=new Qi;throw t.init(),t.open(),new w(y.ERROR_LOOPBACK_ACCESS_BLOCKED,"Local Network Access permission denied")}else if(e.state==="prompt"){let t=new nc;if(await new Promise((n,r)=>{t.addEventListener("close",o=>{o&&r(new w(y.ERROR_ASSOCIATION_CANCELLED,"Wallet connection cancelled by user",{event:o}))}),e.onchange=()=>{e.onchange=null,n(e.state)},t.init(),t.open()})==="granted"){let n=new $i;await new Promise((r,o)=>{n.addEventListener("close",s=>{s&&o(new w(y.ERROR_ASSOCIATION_CANCELLED,"Wallet connection cancelled by user",{event:s}))}),n.initWithCallback(async()=>{r(!0)}),n.open()});return}else return await Ps()}throw new w(y.ERROR_LOOPBACK_ACCESS_BLOCKED,"Local Network Access permission unknown")}catch(e){if(e instanceof TypeError&&(e.message.includes("loopback-network")||e.message.includes("local-network-access")))return;throw e instanceof w?e:new w(y.ERROR_LOOPBACK_ACCESS_BLOCKED,e instanceof Error?e.message:"Local Network Access permission unknown")}}var dc=`
<div class="mobile-wallet-adapter-embedded-loading-indicator" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div data-modal-close style="position: absolute; width: 100%; height: 100%;"></div>
    <div class="mobile-wallet-adapter-embedded-loading-container">
        <div class="mobile-wallet-adapter-embedded-loading-animation"></div>
    </div>
</div>
`,Rc=`
.mobile-wallet-adapter-embedded-loading-indicator {
    display: flex; /* Use flexbox to center content */
    justify-content: center; /* Center horizontally */
    align-items: start; /* Center vertically */
    position: fixed; /* Stay in place */
    z-index: 1; /* Sit on top */
    left: 0;
    top: 0;
    width: 100%; /* Full width */
    height: 100%; /* Full height */
    background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
    overflow-y: auto; /* enable scrolling */
}

.mobile-wallet-adapter-embedded-loading-container {
    display: flex;
    margin: auto;
}

.mobile-wallet-adapter-embedded-loading-animation {
    position: relative;
    left: -9999px;
    width: 10px;
    height: 10px;
    border-radius: 5px;
    background-color: var(--spinner-color);
    color: var(--spinner-color);
    box-shadow: 9984px 0 0 0 var(--spinner-color), 
                9999px 0 0 0 var(--spinner-color), 
                10014px 0 0 0 var(--spinner-color);
    animation: dot-typing 1.5s infinite linear;
}

@keyframes dot-typing {
    0% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    16.667% {
        box-shadow: 9984px -10px 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    33.333% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    50% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px -10px 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    66.667% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    83.333% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px -10px 0 0 var(--spinner-color);
    }
    100% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
}
`,ne,Me,$e,Ke,Fs,Hs,Gs,Mt,gs,Ec=(gs=class{constructor(){R(this,Ke);R(this,ne,null);R(this,Me,{});R(this,$e,!1);u(this,"dom",null);u(this,"open",()=>{console.debug("Modal open"),J(this,Ke,Hs).call(this),i(this,ne)&&(i(this,ne).style.display="flex")});u(this,"close",(e=void 0)=>{console.debug("Modal close"),J(this,Ke,Gs).call(this),i(this,ne)&&(i(this,ne).style.display="none"),i(this,Me).close?.forEach(t=>t(e))});R(this,Mt,e=>{e.key==="Escape"&&this.close(e)});this.init=this.init.bind(this),g(this,ne,document.getElementById("mobile-wallet-adapter-embedded-root-ui"))}async init(){console.log("Injecting modal"),J(this,Ke,Fs).call(this)}addEventListener(e,t){return i(this,Me)[e]?.push(t)||(i(this,Me)[e]=[t]),()=>this.removeEventListener(e,t)}removeEventListener(e,t){i(this,Me)[e]=i(this,Me)[e]?.filter(n=>t!==n)}},ne=new WeakMap,Me=new WeakMap,$e=new WeakMap,Ke=new WeakSet,Fs=function(){if(this.dom)return;g(this,ne,document.createElement("div")),i(this,ne).id="mobile-wallet-adapter-embedded-root-ui",i(this,ne).innerHTML=dc,i(this,ne).style.display="none";let e=document.createElement("style");e.id="mobile-wallet-adapter-embedded-modal-styles",e.textContent=Rc;let t=document.createElement("div");this.dom=t.attachShadow({mode:"closed"}),t.style.setProperty("--spinner-color","#FFFFFF"),this.dom.appendChild(e),this.dom.appendChild(i(this,ne)),document.body.appendChild(t)},Hs=function(){!i(this,ne)||i(this,$e)||([...i(this,ne).querySelectorAll("[data-modal-close]")].forEach(e=>e?.addEventListener("click",t=>{this.close(t)})),window.addEventListener("load",this.close),document.addEventListener("keydown",i(this,Mt)),g(this,$e,!0))},Gs=function(){i(this,$e)&&(window.removeEventListener("load",this.close),document.removeEventListener("keydown",i(this,Mt)),i(this,ne)&&([...i(this,ne).querySelectorAll("[data-modal-close]")].forEach(e=>e?.removeEventListener("click",this.close)),g(this,$e,!1)))},Mt=new WeakMap,gs),uc=class extends en{constructor(){super(...arguments);u(this,"contentStyles",Oc);u(this,"contentHtml",fc)}async initWithQR(t){super.init(),this.populateQRCode(t)}async populateQRCode(t){let n=this.dom?.getElementById("mobile-wallet-adapter-embedded-modal-qr-code-container");if(n){let r=await Ss.toCanvas(t,{width:200,margin:0});n.firstElementChild!==null?n.replaceChild(r,n.firstElementChild):n.appendChild(r);let o=this.dom?.getElementById("mobile-wallet-adapter-embedded-modal-qr-placeholder");o&&(o.style.display="none")}else console.error("QRCode Container not found")}},fc=`
<div class="mobile-wallet-adapter-embedded-modal-qr-content">
    <div>
        <svg class="mobile-wallet-adapter-embedded-modal-icon" width="100%" height="100%">
            <circle r="52" cx="53" cy="53" fill="#99b3be" stroke="#000000" stroke-width="2"/>
            <path d="m 53,82.7305 c -3.3116,0 -6.1361,-1.169 -8.4735,-3.507 -2.338,-2.338 -3.507,-5.1625 -3.507,-8.4735 0,-3.3116 1.169,-6.1364 3.507,-8.4744 2.3374,-2.338 5.1619,-3.507 8.4735,-3.507 3.3116,0 6.1361,1.169 8.4735,3.507 2.338,2.338 3.507,5.1628 3.507,8.4744 0,3.311 -1.169,6.1355 -3.507,8.4735 -2.3374,2.338 -5.1619,3.507 -8.4735,3.507 z m 0.007,-5.25 c 1.8532,0 3.437,-0.6598 4.7512,-1.9793 1.3149,-1.3195 1.9723,-2.9058 1.9723,-4.7591 0,-1.8526 -0.6598,-3.4364 -1.9793,-4.7512 -1.3195,-1.3149 -2.9055,-1.9723 -4.7582,-1.9723 -1.8533,0 -3.437,0.6598 -4.7513,1.9793 -1.3148,1.3195 -1.9722,2.9058 -1.9722,4.7591 0,1.8527 0.6597,3.4364 1.9792,4.7512 1.3195,1.3149 2.9056,1.9723 4.7583,1.9723 z m -28,-33.5729 -3.85,-3.6347 c 4.1195,-4.025 8.8792,-7.1984 14.2791,-9.52 5.4005,-2.3223 11.2551,-3.4834 17.5639,-3.4834 6.3087,0 12.1634,1.1611 17.5639,3.4834 5.3999,2.3216 10.1596,5.495 14.2791,9.52 l -3.85,3.6347 C 77.2999,40.358 73.0684,37.5726 68.2985,35.5514 63.5292,33.5301 58.4296,32.5195 53,32.5195 c -5.4297,0 -10.5292,1.0106 -15.2985,3.0319 -4.7699,2.0212 -9.0014,4.8066 -12.6945,8.3562 z m 44.625,10.8771 c -2.2709,-2.1046 -4.7962,-3.7167 -7.5758,-4.8361 -2.7795,-1.12 -5.7983,-1.68 -9.0562,-1.68 -3.2579,0 -6.2621,0.56 -9.0125,1.68 -2.7504,1.1194 -5.2903,2.7315 -7.6195,4.8361 L 32.5189,51.15 c 2.8355,-2.6028 5.9777,-4.6086 9.4263,-6.0174 3.4481,-1.4087 7.133,-2.1131 11.0548,-2.1131 3.9217,0 7.5979,0.7044 11.0285,2.1131 3.43,1.4088 6.5631,3.4146 9.3992,6.0174 z"/>
        </svg>
        <div class="mobile-wallet-adapter-embedded-modal-title">Remote Mobile Wallet Adapter</div>
    </div>
    <div>
        <div>
            <h4 class="mobile-wallet-adapter-embedded-modal-qr-label">
                Open your wallet and scan this code
            </h4>
        </div>
        <div id="mobile-wallet-adapter-embedded-modal-qr-code-container" class="mobile-wallet-adapter-embedded-modal-qr-code-container">
            <div id="mobile-wallet-adapter-embedded-modal-qr-placeholder" class="mobile-wallet-adapter-embedded-modal-qr-placeholder"></div>
        </div>
    </div>
</div>
<div class="mobile-wallet-adapter-embedded-modal-divider"><hr></div>
<div class="mobile-wallet-adapter-embedded-modal-footer">
    <div class="mobile-wallet-adapter-embedded-modal-subtitle">
        Follow the instructions on your device. When you're finished, this screen will update.
    </div>
    <div class="mobile-wallet-adapter-embedded-modal-progress-badge">
        <div>
            <div class="spinner">
                <div class="leftWrapper">
                    <div class="left">
                        <div class="circle"></div>
                    </div>
                </div>
                <div class="rightWrapper">
                    <div class="right">
                        <div class="circle"></div>
                    </div>
                </div>
            </div>
        </div>
        <div>Waiting for scan</div>
    </div>
</div>
`,Oc=`
.mobile-wallet-adapter-embedded-modal-qr-content {
    display: flex; 
    margin-top: 10px;
    padding: 10px;
}

.mobile-wallet-adapter-embedded-modal-qr-content > div:first-child {
    display: flex;
    flex-direction: column;
    flex: 2;
    margin-top: auto;
    margin-right: 30px;
}

.mobile-wallet-adapter-embedded-modal-qr-content > div:nth-child(2) {
    display: flex;
    flex-direction: column;
    flex: 1;
    margin-left: auto;
}

.mobile-wallet-adapter-embedded-modal-footer {
    display: flex;
    padding: 10px;
}

.mobile-wallet-adapter-embedded-modal-icon {}

.mobile-wallet-adapter-embedded-modal-title {
    color: #000000;
    font-size: 2.5em;
    font-weight: 600;
}

.mobile-wallet-adapter-embedded-modal-qr-label {
    text-align: right;
    color: #000000;
}

.mobile-wallet-adapter-embedded-modal-qr-code-container {
    margin-left: auto;
}

.mobile-wallet-adapter-embedded-modal-qr-placeholder {
    margin-left: auto;
    min-width: 200px;
    min-height: 200px;
    background: linear-gradient(-60deg, #F7F8F8 30%, #ECEEEE 50%, #F7F8F8 70%);
    background-size: 200%;
    animation: placeholderAnimate 2.7s linear infinite;
    border-radius: 12px;
}

.mobile-wallet-adapter-embedded-modal-divider {
    margin-top: 20px;
    padding-left: 10px;
    padding-right: 10px;
}

.mobile-wallet-adapter-embedded-modal-divider hr {
    border-top: 1px solid #D9DEDE;
}

.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: auto;
    margin-right: 60px;
    padding: 20px;
    color: #6E8286;
}

.mobile-wallet-adapter-embedded-modal-progress-badge {
    display: flex;
    background: #F7F8F8;
    height: 56px;
    min-width: 200px;
    margin: auto;
    padding-left: 20px;
    padding-right: 20px;
    border-radius: 18px;
    color: #A8B6B8;
    align-items: center;
}

.mobile-wallet-adapter-embedded-modal-progress-badge > div:first-child {
    margin-left: auto;
    margin-right: 20px;
}

.mobile-wallet-adapter-embedded-modal-progress-badge > div:nth-child(2) {
    margin-right: auto;
}

/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-card {
        text-align: center;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content {
        flex-direction: column;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content > div:first-child {
        margin: auto;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content > div:nth-child(2) {
        margin: auto;
        flex: 2 auto;
    }
    .mobile-wallet-adapter-embedded-modal-footer {
        flex-direction: column;
    }
    .mobile-wallet-adapter-embedded-modal-icon {
        display: none;
    }
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: unset;
    }
    .mobile-wallet-adapter-embedded-modal-qr-label {
        text-align: center;
    }
    .mobile-wallet-adapter-embedded-modal-qr-code-container {
        margin: auto;
    }
    .mobile-wallet-adapter-embedded-modal-qr-placeholder {
        margin: auto;
    }
}

/* QR Placeholder */
@keyframes placeholderAnimate {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* Spinner */
@keyframes spinLeft {
    0% {
        transform: rotate(20deg);
    }
    50% {
        transform: rotate(160deg);
    }
    100% {
        transform: rotate(20deg);
    }
}
@keyframes spinRight {
    0% {
        transform: rotate(160deg);
    }
    50% {
        transform: rotate(20deg);
    }
    100% {
        transform: rotate(160deg);
    }
}
@keyframes spin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(2520deg);
    }
}

.spinner {
    position: relative;
    width: 1.5em;
    height: 1.5em;
    margin: auto;
    animation: spin 10s linear infinite;
}
.spinner::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
}
.right, .rightWrapper, .left, .leftWrapper {
    position: absolute;
    top: 0;
    overflow: hidden;
    width: .75em;
    height: 1.5em;
}
.left, .leftWrapper {
    left: 0;
}
.right {
    left: -12px;
}
.rightWrapper {
    right: 0;
}
.circle {
    border: .125em solid #A8B6B8;
    width: 1.25em; /* 1.5em - 2*0.125em border */
    height: 1.25em; /* 1.5em - 2*0.125em border */
    border-radius: 0.75em; /* 0.5*1.5em spinner size 8 */
}
.left {
    transform-origin: 100% 50%;
    animation: spinLeft 2.5s cubic-bezier(.2,0,.8,1) infinite;
}
.right {
    transform-origin: 100% 50%;
    animation: spinRight 2.5s cubic-bezier(.2,0,.8,1) infinite;
}
`,ks="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik03IDIuNUgxN0MxNy44Mjg0IDIuNSAxOC41IDMuMTcxNTcgMTguNSA0VjIwQzE4LjUgMjAuODI4NCAxNy44Mjg0IDIxLjUgMTcgMjEuNUg3QzYuMTcxNTcgMjEuNSA1LjUgMjAuODI4NCA1LjUgMjBWNEM1LjUgMy4xNzE1NyA2LjE3MTU3IDIuNSA3IDIuNVpNMyA0QzMgMS43OTA4NiA0Ljc5MDg2IDAgNyAwSDE3QzE5LjIwOTEgMCAyMSAxLjc5MDg2IDIxIDRWMjBDMjEgMjIuMjA5MSAxOS4yMDkxIDI0IDE3IDI0SDdDNC43OTA4NiAyNCAzIDIyLjIwOTEgMyAyMFY0Wk0xMSA0LjYxNTM4QzEwLjQ0NzcgNC42MTUzOCAxMCA1LjA2MzEgMTAgNS42MTUzOFY2LjM4NDYyQzEwIDYuOTM2OSAxMC40NDc3IDcuMzg0NjIgMTEgNy4zODQ2MkgxM0MxMy41NTIzIDcuMzg0NjIgMTQgNi45MzY5IDE0IDYuMzg0NjJWNS42MTUzOEMxNCA1LjA2MzEgMTMuNTUyMyA0LjYxNTM4IDEzIDQuNjE1MzhIMTFaIiBmaWxsPSIjRENCOEZGIi8+Cjwvc3ZnPgo=",Ac="Mobile Wallet Adapter",hc="Remote Mobile Wallet Adapter",Vs=[Ne,pe,Cn,bn],Sc=3e4;function zs(e,t){return e?.length===t?.length&&(e??[]).every((n,r)=>n===t?.[r])}function Ks(e){if(Ne in e)return e[Ne].supportedTransactionVersions;if(pe in e)return e[pe].supportedTransactionVersions}function le(e){return e instanceof Error?e.message:"Unknown error"}var Pe,Un,Bn,Mn,Pn,St,re,me,Ie,Nt,Fe,Pt,Ze,Ft,Je,Fn,ke,yn,Ws,Hn,Ht,Qe,Gt,pt,kt,et,mt,Vt,Gn,kn,zt,Kt,Vn,zn,Wt,ws,Nc=(ws=class{constructor({appIdentity:e,authorizationCache:t=tr(),chains:n,chainSelector:r=Cs(),onWalletNotFound:o=vs(),nostrRelay:s}){R(this,ke);R(this,Pe,{});R(this,Un,"1.0.0");R(this,Bn,Ac);R(this,Mn,"https://solanamobile.com/wallets");R(this,Pn,ks);R(this,St);R(this,re);R(this,me);R(this,Ie,!1);R(this,Nt,0);R(this,Fe,[]);R(this,Pt);R(this,Ze);R(this,Ft);R(this,Je);R(this,Fn,(e,t)=>(i(this,Pe)[e]?.push(t)||(i(this,Pe)[e]=[t]),()=>J(this,ke,Ws).call(this,e,t)));R(this,Hn,async({silent:e}={})=>{if(i(this,Ie)||this.connected)return{accounts:this.accounts};g(this,Ie,!0);try{if(e){let t=await i(this,me).get();if(t)await i(this,Gt).call(this,t.capabilities),await i(this,Qe).call(this,t);else return{accounts:this.accounts}}else await i(this,Ht).call(this)}catch(t){throw new Error(le(t),{cause:t})}finally{g(this,Ie,!1)}return{accounts:this.accounts}});R(this,Ht,async e=>{try{let t=await i(this,me).get();if(t)return i(this,Qe).call(this,t),t;let n=await i(this,Pt).select(i(this,Fe));return await i(this,et).call(this,async r=>{let[o,s]=await Promise.all([r.getCapabilities(),r.authorize({chain:n,identity:i(this,St),sign_in_payload:e})]),a=i(this,Vt).call(this,s.accounts),c={...s,accounts:a,chain:n,capabilities:o};return Promise.all([i(this,Gt).call(this,o),i(this,me).set(c),i(this,Qe).call(this,c)]),c})}catch(t){throw new Error(le(t),{cause:t})}});R(this,Qe,async e=>{let t=i(this,re)==null||i(this,re)?.accounts.length!==e.accounts.length||i(this,re).accounts.some((n,r)=>n.address!==e.accounts[r].address);g(this,re,e),t&&J(this,ke,yn).call(this,"change",{accounts:this.accounts})});R(this,Gt,async e=>{let t=e.features.includes("solana:signTransactions"),n=e.supports_sign_and_send_transactions,r=Ne in this.features!==n||pe in this.features!==t||!zs(Ks(i(this,Ze)),e.supported_transaction_versions);g(this,Ze,{...(n||!n&&!t)&&{[Ne]:{version:"1.0.0",supportedTransactionVersions:e.supported_transaction_versions,signAndSendTransaction:i(this,zt)}},...t&&{[pe]:{version:"1.0.0",supportedTransactionVersions:e.supported_transaction_versions,signTransaction:i(this,Kt)}}}),r&&J(this,ke,yn).call(this,"change",{features:this.features})});R(this,pt,async(e,t,n)=>{try{let[r,o]=await Promise.all([i(this,re)?.capabilities??await e.getCapabilities(),e.authorize({auth_token:t,identity:i(this,St),chain:n})]),s=i(this,Vt).call(this,o.accounts),a={...o,accounts:s,chain:n,capabilities:r};Promise.all([i(this,me).set(a),i(this,Qe).call(this,a)])}catch(r){throw i(this,kt).call(this),new Error(le(r),{cause:r})}});R(this,kt,async()=>{i(this,me).clear(),g(this,Ie,!1),rr(this,Nt)._++,g(this,re,void 0),J(this,ke,yn).call(this,"change",{accounts:this.accounts})});R(this,et,async e=>{let t=i(this,re)?.wallet_uri_base,n=t?{baseUri:t}:void 0,r=i(this,Nt),o=new Ec;try{let s=!0,a,c=await _c(),l=await Promise.race([(async()=>{!c&&!i(this,Je)&&await Ps()})().then(async()=>{o.init();let{wallet:_,close:d}=!c&&i(this,Je)?await Vr({...n,connectionType:"local",relayDomain:i(this,Je)}):await As(n);s=!1,o.addEventListener("close",h=>{h&&d()}),o.open();let A=await e(await _);return o.close(),d(),A}),new Promise((_,d)=>{a=setTimeout(()=>{s&&d(new w(y.ERROR_ASSOCIATION_CANCELLED,"Wallet connection timed out",{event:void 0}))},Sc)})]);return clearTimeout(a),l}catch(s){throw o.close(),i(this,Nt)!==r&&await new Promise(()=>{}),s instanceof Error&&s.name==="SolanaMobileWalletAdapterError"&&s.code==="ERROR_WALLET_NOT_FOUND"&&await i(this,Ft).call(this,this),s}});R(this,mt,()=>{if(!i(this,re))throw new Error("Wallet not connected");return{authToken:i(this,re).auth_token,chain:i(this,re).chain}});R(this,Vt,e=>e.map(t=>{let n=Q(t.address);return{address:st(n),publicKey:n,label:t.label,icon:t.icon,chains:t.chains??i(this,Fe),features:t.features??Vs}}));R(this,Gn,async e=>{let{authToken:t,chain:n}=i(this,mt).call(this);try{let r=e.map(o=>he(o));return await i(this,et).call(this,async o=>(await i(this,pt).call(this,o,t,n),(await o.signTransactions({payloads:r})).signed_payloads.map(Q)))}catch(r){throw new Error(le(r),{cause:r})}});R(this,kn,async(e,t)=>{let{authToken:n,chain:r}=i(this,mt).call(this);try{return await i(this,et).call(this,async o=>{let[s]=await Promise.all([o.getCapabilities(),i(this,pt).call(this,o,n,r)]);if(s.supports_sign_and_send_transactions){let a=he(e);return(await o.signAndSendTransactions({...t,payloads:[a]})).signatures.map(Q)[0]}else throw new Error("connected wallet does not support signAndSendTransaction")})}catch(o){throw new Error(le(o),{cause:o})}});R(this,zt,async(...e)=>{let t=[];for(let n of e){let r=await i(this,kn).call(this,n.transaction,n.options);t.push({signature:r})}return t});R(this,Kt,async(...e)=>(await i(this,Gn).call(this,e.map(({transaction:t})=>t))).map(t=>({signedTransaction:t})));R(this,Vn,async(...e)=>{let{authToken:t,chain:n}=i(this,mt).call(this),r=e.map(({account:s})=>he(new Uint8Array(s.publicKey))),o=e.map(({message:s})=>he(s));try{return await i(this,et).call(this,async s=>(await i(this,pt).call(this,s,t,n),(await s.signMessages({addresses:r,payloads:o})).signed_payloads.map(Q).map(a=>({signedMessage:a,signature:a.slice(-64)}))))}catch(s){throw new Error(le(s),{cause:s})}});R(this,zn,async(...e)=>{let t=[];if(e.length>1)for(let n of e)t.push(await i(this,Wt).call(this,n));else return[await i(this,Wt).call(this,e[0])];return t});R(this,Wt,async e=>{g(this,Ie,!0);try{let t=await i(this,Ht).call(this,{...e,domain:e?.domain??window.location.host});if(!t.sign_in_result)throw new Error("Sign in failed, no sign in result returned by wallet");let n=t.sign_in_result.address,r=t.accounts.find(o=>o.address==n);return{account:{...r??{address:st(Q(n))},publicKey:Q(n),chains:r?.chains??i(this,Fe),features:r?.features??t.capabilities.features},signedMessage:Q(t.sign_in_result.signed_message),signature:Q(t.sign_in_result.signature)}}catch(t){throw new Error(le(t),{cause:t})}finally{g(this,Ie,!1)}});g(this,me,t),g(this,St,e),g(this,Fe,n),g(this,Pt,r),g(this,Ft,o),g(this,Je,s),g(this,Ze,{[Ne]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signAndSendTransaction:i(this,zt)},[pe]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signTransaction:i(this,Kt)}})}get version(){return i(this,Un)}get name(){return i(this,Bn)}get url(){return i(this,Mn)}get icon(){return i(this,Pn)}get chains(){return i(this,Fe)}get features(){return{[zr]:{version:"1.0.0",connect:i(this,Hn)},[Kr]:{version:"1.0.0",disconnect:i(this,kt)},[Wr]:{version:"1.0.0",on:i(this,Fn)},[Cn]:{version:"1.0.0",signMessage:i(this,Vn)},[bn]:{version:"1.0.0",signIn:i(this,zn)},...i(this,Ze)}}get accounts(){return i(this,re)?.accounts??[]}get connected(){return!!i(this,re)}get isAuthorized(){return!!i(this,re)}get currentAuthorization(){return i(this,re)}get cachedAuthorizationResult(){return i(this,me).get()}},Pe=new WeakMap,Un=new WeakMap,Bn=new WeakMap,Mn=new WeakMap,Pn=new WeakMap,St=new WeakMap,re=new WeakMap,me=new WeakMap,Ie=new WeakMap,Nt=new WeakMap,Fe=new WeakMap,Pt=new WeakMap,Ze=new WeakMap,Ft=new WeakMap,Je=new WeakMap,Fn=new WeakMap,ke=new WeakSet,yn=function(e,...t){i(this,Pe)[e]?.forEach(n=>n.apply(null,t))},Ws=function(e,t){i(this,Pe)[e]=i(this,Pe)[e]?.filter(n=>t!==n)},Hn=new WeakMap,Ht=new WeakMap,Qe=new WeakMap,Gt=new WeakMap,pt=new WeakMap,kt=new WeakMap,et=new WeakMap,mt=new WeakMap,Vt=new WeakMap,Gn=new WeakMap,kn=new WeakMap,zt=new WeakMap,Kt=new WeakMap,Vn=new WeakMap,zn=new WeakMap,Wt=new WeakMap,ws),He,Kn,Wn,Yn,jn,Tt,oe,ge,we,It,Ge,Yt,tt,jt,nt,de,qn,Ve,Ln,Ys,Xn,qt,gt,$n,wt,Xt,rt,bt,$t,Zn,Jn,Zt,Jt,Qn,er,Qt,bs,Ns=(bs=class{constructor(e){R(this,Ve);R(this,He,{});R(this,Kn,"1.0.0");R(this,Wn,hc);R(this,Yn,"https://solanamobile.com/wallets");R(this,jn,ks);R(this,Tt);R(this,oe);R(this,ge);R(this,we,!1);R(this,It,0);R(this,Ge,[]);R(this,Yt);R(this,tt);R(this,jt);R(this,nt);R(this,de);R(this,qn,(e,t)=>(i(this,He)[e]?.push(t)||(i(this,He)[e]=[t]),()=>J(this,Ve,Ys).call(this,e,t)));R(this,Xn,async(e={})=>{if(i(this,we)||this.connected)return{accounts:this.accounts};g(this,we,!0);try{await i(this,qt).call(this)}catch(t){throw new Error(le(t),{cause:t})}finally{g(this,we,!1)}return{accounts:this.accounts}});R(this,qt,async e=>{try{let t=await i(this,ge).get();if(t)return i(this,gt).call(this,t),t;i(this,de)&&g(this,de,void 0);let n=await i(this,Yt).select(i(this,Ge));return await i(this,rt).call(this,async r=>{let[o,s]=await Promise.all([r.getCapabilities(),r.authorize({chain:n,identity:i(this,Tt),sign_in_payload:e})]),a=i(this,$t).call(this,s.accounts),c={...s,accounts:a,chain:n,capabilities:o};return Promise.all([i(this,$n).call(this,o),i(this,ge).set(c),i(this,gt).call(this,c)]),c})}catch(t){throw new Error(le(t),{cause:t})}});R(this,gt,async e=>{let t=i(this,oe)==null||i(this,oe)?.accounts.length!==e.accounts.length||i(this,oe).accounts.some((n,r)=>n.address!==e.accounts[r].address);g(this,oe,e),t&&J(this,Ve,Ln).call(this,"change",{accounts:this.accounts})});R(this,$n,async e=>{let t=e.features.includes("solana:signTransactions"),n=e.supports_sign_and_send_transactions||e.features.includes("solana:signAndSendTransaction"),r=Ne in this.features!==n||pe in this.features!==t||!zs(Ks(i(this,tt)),e.supported_transaction_versions);g(this,tt,{...n&&{[Ne]:{version:"1.0.0",supportedTransactionVersions:e.supported_transaction_versions,signAndSendTransaction:i(this,Zt)}},...t&&{[pe]:{version:"1.0.0",supportedTransactionVersions:e.supported_transaction_versions,signTransaction:i(this,Jt)}}}),r&&J(this,Ve,Ln).call(this,"change",{features:this.features})});R(this,wt,async(e,t,n)=>{try{let[r,o]=await Promise.all([i(this,oe)?.capabilities??await e.getCapabilities(),e.authorize({auth_token:t,identity:i(this,Tt),chain:n})]),s=i(this,$t).call(this,o.accounts),a={...o,accounts:s,chain:n,capabilities:r};Promise.all([i(this,ge).set(a),i(this,gt).call(this,a)])}catch(r){throw i(this,Xt).call(this),new Error(le(r),{cause:r})}});R(this,Xt,async()=>{i(this,de)?.close(),i(this,ge).clear(),g(this,we,!1),rr(this,It)._++,g(this,oe,void 0),g(this,de,void 0),J(this,Ve,Ln).call(this,"change",{accounts:this.accounts})});R(this,rt,async e=>{let t=i(this,oe)?.wallet_uri_base,n=t?{baseUri:t}:void 0,r=i(this,It),o=new uc;if(i(this,de))return e(i(this,de).wallet);try{o.init(),o.open();let{associationUrl:s,close:a,wallet:c}=i(this,nt).kind=="reflector"?await hs({...n,remoteHostAuthority:i(this,nt).domain}):await Vr({...n,connectionType:"remote",relayDomain:i(this,nt).domain}),l=o.addEventListener("close",_=>{_&&a()});return o.populateQRCode(s.toString()),g(this,de,{close:a,wallet:await c}),l(),o.close(),await e(i(this,de).wallet)}catch(s){throw o.close(),i(this,It)!==r&&await new Promise(()=>{}),s instanceof Error&&s.name==="SolanaMobileWalletAdapterError"&&s.code==="ERROR_WALLET_NOT_FOUND"&&await i(this,jt).call(this,this),s}});R(this,bt,()=>{if(!i(this,oe))throw new Error("Wallet not connected");return{authToken:i(this,oe).auth_token,chain:i(this,oe).chain}});R(this,$t,e=>e.map(t=>{let n=Q(t.address);return{address:st(n),publicKey:n,label:t.label,icon:t.icon,chains:t.chains??i(this,Ge),features:t.features??Vs}}));R(this,Zn,async e=>{let{authToken:t,chain:n}=i(this,bt).call(this);try{return await i(this,rt).call(this,async r=>(await i(this,wt).call(this,r,t,n),(await r.signTransactions({payloads:e.map(he)})).signed_payloads.map(Q)))}catch(r){throw new Error(le(r),{cause:r})}});R(this,Jn,async(e,t)=>{let{authToken:n,chain:r}=i(this,bt).call(this);try{return await i(this,rt).call(this,async o=>{let[s]=await Promise.all([o.getCapabilities(),i(this,wt).call(this,o,n,r)]);if(s.supports_sign_and_send_transactions)return(await o.signAndSendTransactions({...t,payloads:[he(e)]})).signatures.map(Q)[0];throw new Error("connected wallet does not support signAndSendTransaction")})}catch(o){throw new Error(le(o),{cause:o})}});R(this,Zt,async(...e)=>{let t=[];for(let n of e){let r=await i(this,Jn).call(this,n.transaction,n.options);t.push({signature:r})}return t});R(this,Jt,async(...e)=>(await i(this,Zn).call(this,e.map(({transaction:t})=>t))).map(t=>({signedTransaction:t})));R(this,Qn,async(...e)=>{let{authToken:t,chain:n}=i(this,bt).call(this),r=e.map(({account:s})=>he(new Uint8Array(s.publicKey))),o=e.map(({message:s})=>he(s));try{return await i(this,rt).call(this,async s=>(await i(this,wt).call(this,s,t,n),(await s.signMessages({addresses:r,payloads:o})).signed_payloads.map(Q).map(a=>({signedMessage:a,signature:a.slice(-64)}))))}catch(s){throw new Error(le(s),{cause:s})}});R(this,er,async(...e)=>{let t=[];if(e.length>1)for(let n of e)t.push(await i(this,Qt).call(this,n));else return[await i(this,Qt).call(this,e[0])];return t});R(this,Qt,async e=>{g(this,we,!0);try{let t=await i(this,qt).call(this,{...e,domain:e?.domain??window.location.host});if(!t.sign_in_result)throw new Error("Sign in failed, no sign in result returned by wallet");let n=t.sign_in_result.address,r=t.accounts.find(o=>o.address==n);return{account:{...r??{address:st(Q(n))},publicKey:Q(n),chains:r?.chains??i(this,Ge),features:r?.features??t.capabilities.features},signedMessage:Q(t.sign_in_result.signed_message),signature:Q(t.sign_in_result.signature)}}catch(t){throw new Error(le(t),{cause:t})}finally{g(this,we,!1)}});let{appIdentity:t,authorizationCache:n=tr(),chains:r,chainSelector:o=Cs(),onWalletNotFound:s=vs()}=e;g(this,ge,n),g(this,Tt,t),g(this,Ge,r),g(this,Yt,o),g(this,nt,"remoteHostAuthority"in e?{kind:"reflector",domain:e.remoteHostAuthority}:{kind:"nostr",domain:e.nostrRelay}),g(this,jt,s),g(this,tt,{[Ne]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signAndSendTransaction:i(this,Zt)},[pe]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signTransaction:i(this,Jt)}})}get version(){return i(this,Kn)}get name(){return i(this,Wn)}get url(){return i(this,Yn)}get icon(){return i(this,jn)}get chains(){return i(this,Ge)}get features(){return{[zr]:{version:"1.0.0",connect:i(this,Xn)},[Kr]:{version:"1.0.0",disconnect:i(this,Xt)},[Wr]:{version:"1.0.0",on:i(this,qn)},[Cn]:{version:"1.0.0",signMessage:i(this,Qn)},[bn]:{version:"1.0.0",signIn:i(this,er)},...i(this,tt)}}get accounts(){return i(this,oe)?.accounts??[]}get connected(){return!!i(this,de)&&!!i(this,oe)}get isAuthorized(){return!!i(this,oe)}get currentAuthorization(){return i(this,oe)}get cachedAuthorizationResult(){return i(this,ge).get()}},He=new WeakMap,Kn=new WeakMap,Wn=new WeakMap,Yn=new WeakMap,jn=new WeakMap,Tt=new WeakMap,oe=new WeakMap,ge=new WeakMap,we=new WeakMap,It=new WeakMap,Ge=new WeakMap,Yt=new WeakMap,tt=new WeakMap,jt=new WeakMap,nt=new WeakMap,de=new WeakMap,qn=new WeakMap,Ve=new WeakSet,Ln=function(e,...t){i(this,He)[e]?.forEach(n=>n.apply(null,t))},Ys=function(e,t){i(this,He)[e]=i(this,He)[e]?.filter(n=>t!==n)},Xn=new WeakMap,qt=new WeakMap,gt=new WeakMap,$n=new WeakMap,wt=new WeakMap,Xt=new WeakMap,rt=new WeakMap,bt=new WeakMap,$t=new WeakMap,Zn=new WeakMap,Jn=new WeakMap,Zt=new WeakMap,Jt=new WeakMap,Qn=new WeakMap,er=new WeakMap,Qt=new WeakMap,bs);function js(e){if(typeof window>"u"){console.warn("MWA not registered: no window object");return}if(!window.isSecureContext){console.warn("MWA not registered: secure context required (https)");return}let t=navigator.userAgent;sc()&&(!ic(t)||jr(t))?an(new Nc(e)):ac()&&("nostrRelay"in e||e.remoteHostAuthority!==void 0)?"nostrRelay"in e?an(new Ns({...e,nostrRelay:e.nostrRelay})):an(new Ns({...e,remoteHostAuthority:e.remoteHostAuthority})):console.warn("MWA not registered: device or environment not supported")}var qs=!1;function pc(){try{let e=document.querySelector('link[rel~="apple-touch-icon"][href]');if(!e)return null;let t=new URL(e.getAttribute("href"),location.href);return t.origin===location.origin?t.pathname.replace(/^\/+/,"")+t.search:null}catch{return null}}function mc(e){let t=tr();return{clear:()=>t.clear(),get:async()=>{let n=await t.get();return n&&n.chain===e?n:void 0},set:n=>t.set(n)}}function Tc({chain:e,notFound:t}={}){if(qs)return;qs=!0,e!=="solana:devnet"&&e!=="solana:mainnet"&&(e="solana:devnet");let n={name:"Nox",uri:location.origin},r=pc();r&&(n.icon=r),js({appIdentity:n,chains:[e],authorizationCache:mc(e),onWalletNotFound:async()=>{try{typeof t=="function"&&t()}catch{}}})}return ta(Ic);})();
/* The licenses of the packages bundled above, each text as its packages ship it.

=== @noble/curves@2.4.0 (MIT), @noble/hashes@2.4.0 (MIT)

The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

=== @solana-mobile/mobile-wallet-adapter-protocol@3.0.1 (Apache-2.0)

Copyright 2022 Solana Mobile Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

=== @solana-mobile/wallet-standard-mobile@0.7.0 (Apache-2.0)

Copyright 2025 Solana Mobile Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

=== @solana/codecs-core@8.5.0 (MIT), @solana/codecs-strings@8.5.0 (MIT), @solana/errors@8.5.0 (MIT)

Copyright (c) 2023 Solana Labs, Inc

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

=== @solana/wallet-standard-chains@1.1.2 (Apache-2.0), @solana/wallet-standard-features@1.5.0 (Apache-2.0), @solana/wallet-standard-util@1.2.0 (Apache-2.0), @wallet-standard/features@1.1.1 (Apache-2.0), @wallet-standard/wallet@1.1.1 (Apache-2.0)

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
