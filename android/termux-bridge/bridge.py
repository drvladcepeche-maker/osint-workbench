#!/data/data/com.termux/files/usr/bin/python
import json, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
REPO="drvladcepeche-maker/osint-workbench"
class Handler(BaseHTTPRequestHandler):
 def send_json(self,status,data):
  raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_POST(self):
  if self.path!="/report":return self.send_json(404,{"error":"not found"})
  try:
   size=int(self.headers.get("Content-Length","0"))
   if size<2 or size>65536:return self.send_json(400,{"error":"invalid report size"})
   d=json.loads(self.rfile.read(size));keys=("event","time","app_version","android","sdk","device","context","error_type","message","stack");report={k:d.get(k) for k in keys}
   title="[Android] "+str(report.get("event") or "diagnostic")[:80];body="Automated mobile diagnostic report\n\n"+json.dumps(report,ensure_ascii=False,indent=2)[:12000]
   p=subprocess.run(["gh","issue","create","--repo",REPO,"--title",title,"--body",body],capture_output=True,text=True,timeout=25)
   if p.returncode:return self.send_json(502,{"error":p.stderr[-1000:]})
   return self.send_json(201,{"created":True,"url":p.stdout.strip()})
  except Exception as e:return self.send_json(500,{"error":type(e).__name__+": "+str(e)[:300]})
 def do_GET(self):
  if self.path!="/issues":return self.send_json(404,{"error":"not found"})
  p=subprocess.run(["gh","issue","list","--repo",REPO,"--state","open","--limit","30","--json","number,title,state,url,labels"],capture_output=True,text=True,timeout=20)
  if p.returncode:return self.send_json(502,{"error":p.stderr[-1000:]})
  try:return self.send_json(200,json.loads(p.stdout))
  except Exception:return self.send_json(502,{"error":"invalid GitHub response"})
 def log_message(self,fmt,*args):print("[bridge] "+fmt%args)
if __name__=="__main__":
 print("Listening on http://127.0.0.1:8765; stop with Ctrl+C");HTTPServer(("127.0.0.1",8765),Handler).serve_forever()
