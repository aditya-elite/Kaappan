import sys, os, uvicorn
if __name__ == '__main__':
    d = os.path.dirname(os.path.abspath(__file__))
    if d not in sys.path:
        sys.path.insert(0, d)
    uvicorn.run('main:app', host='127.0.0.1', port=8000, reload=False, access_log=False)
