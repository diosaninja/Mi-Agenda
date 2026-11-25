/* Libreta de japonés · lecciones (una por día).
   La tarea programada añade cada mañana una lección nueva justo antes del marcador. */
window.LESSONS=[
{"id":"2026-11-25","n":1,"row":"a",
"vocab":[
{"jp":"朝","kana":"あさ","ro":"asa","es":"mañana|la mañana"},
{"jp":"雨","kana":"あめ","ro":"ame","es":"lluvia"},
{"jp":"犬","kana":"いぬ","ro":"inu","es":"perro"},
{"jp":"家","kana":"いえ","ro":"ie","es":"casa"},
{"jp":"上","kana":"うえ","ro":"ue","es":"arriba|encima"},
{"jp":"駅","kana":"えき","ro":"eki","es":"estación"},
{"jp":"青い","kana":"あおい","ro":"aoi","es":"azul"},
{"jp":"おいしい","kana":"おいしい","ro":"oishii","es":"rico|delicioso|bueno"},
{"jp":"アイス","kana":"アイス","ro":"aisu","es":"helado"},
{"jp":"オレンジ","kana":"オレンジ","ro":"orenji","es":"naranja"}],
"frases":[
{"es":"Buenos días.","jp":"おはようございます。","ro":"ohayou gozaimasu","nota":"Forma educada. Entre amigos basta con おはよう."},
{"es":"Esto es un perro.","jp":"これはいぬです。","ro":"kore wa inu desu","nota":"これ = esto (cerca de mí). は se lee «wa» cuando es partícula."},
{"es":"La casa es grande.","jp":"いえはおおきいです。","ro":"ie wa ookii desu","nota":"Adjetivo -い + です para hablar con educación."},
{"es":"Voy a la estación.","jp":"えきにいきます。","ro":"eki ni ikimasu","nota":"いきます = ir (forma -ます). に marca el destino."}],
"particulas":[
{"s":"わたし＿がくせいです。","ok":"は","opts":["は","を","に","で"],"es":"Yo soy estudiante.","why":"は marca el tema de la frase. Se pronuncia «wa»."},
{"s":"みず＿のみます。","ok":"を","opts":["が","を","に","へ"],"es":"Bebo agua.","why":"を marca el objeto directo (lo que bebes). Se pronuncia «o»."},
{"s":"がっこう＿いきます。","ok":"に","opts":["を","で","に","の"],"es":"Voy a la escuela.","why":"に marca el destino de un movimiento. También valdría へ."},
{"s":"いえ＿ごはんをたべます。","ok":"で","opts":["に","で","を","は"],"es":"Como en casa.","why":"で marca el lugar donde ocurre una acción."}],
"kanji":[
{"k":"雨","es":"lluvia","on":"ウ","kun":"あめ, あま","ej":[{"w":"雨","r":"あめ","es":"lluvia"},{"w":"大雨","r":"おおあめ","es":"lluvia fuerte"},{"w":"雨天","r":"うてん","es":"tiempo lluvioso"}]},
{"k":"上","es":"arriba, subir","on":"ジョウ","kun":"うえ, あ(がる), のぼ(る)","ej":[{"w":"上","r":"うえ","es":"arriba"},{"w":"上手","r":"じょうず","es":"hábil, que se le da bien"},{"w":"上がる","r":"あがる","es":"subir"}]}],
"anime":{"exp":"やばい","ro":"yabai","es":"¡Madre mía! / ¡Qué fuerte!","uso":"Muy coloquial. Empezó significando «peligroso», pero hoy se usa tanto para algo malo como para algo increíble. Solo con amigos.","ej":[{"j":"やばい、おいしい！","r":"yabai, oishii!","es":"¡Madre mía, qué rico!"},{"j":"やばい、おくれる！","r":"yabai, okureru!","es":"¡Ay, que llego tarde!"}]},
"verbos":[
{"dic":"たべる","kanji":"食べる","es":"comer","grupo":"2 (-る)","masu":"たべます","masen":"たべません","mashita":"たべました","te":"たべて"},
{"dic":"のむ","kanji":"飲む","es":"beber","grupo":"1 (-う)","masu":"のみます","masen":"のみません","mashita":"のみました","te":"のんで"},
{"dic":"いく","kanji":"行く","es":"ir","grupo":"1 (-う), forma -て irregular","masu":"いきます","masen":"いきません","mashita":"いきました","te":"いって"}],
"lectura":{"titulo":"あさ","jp":"朝[あさ]です。そとは 雨[あめ]です。\nわたしの 犬[いぬ]は 家[いえ]に います。\nわたしは アイスを 食[た]べません。オレンジを 食[た]べます。\nそれから、駅[えき]に 行[い]きます。","ro":"Asa desu. Soto wa ame desu. Watashi no inu wa ie ni imasu. Watashi wa aisu o tabemasen. Orenji o tabemasu. Sorekara, eki ni ikimasu.","es":"Es por la mañana. Fuera llueve. Mi perro está en casa. No como helado. Como una naranja. Después, voy a la estación.",
"glosa":[{"w":"そと","es":"fuera"},{"w":"います","es":"estar (personas y animales)"},{"w":"それから","es":"después, luego"}],
"preguntas":[{"q":"¿Qué tiempo hace?","opts":["Hace sol","Llueve","Nieva"],"ok":"Llueve"},{"q":"¿Dónde está el perro?","opts":["En la estación","Fuera","En casa"],"ok":"En casa"},{"q":"¿Qué come por la mañana?","opts":["Una naranja","Un helado","Arroz"],"ok":"Una naranja"}]}},
/*@@SIGUIENTE_LECCION@@*/
];
