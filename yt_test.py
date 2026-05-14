import yt_dlp
url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
ydl = yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'noplaylist': True, 'nopart': True, 'format': 'bestaudio/best'})
info = ydl.extract_info(url, download=False)
print(type(info))
if hasattr(info, 'keys'):
    print(list(info.keys())[:10])
    print('id', info.get('id'))
    print('title', info.get('title'))
    print('entries type', type(info.get('entries')))
else:
    print(info)
