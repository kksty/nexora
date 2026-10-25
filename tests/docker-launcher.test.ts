import assert from 'node:assert/strict'
import test from 'node:test'
import { joinHostPath } from '../src/web/docker-launcher.ts'

test('Docker：任务容器的宿主机路径按宿主风格拼接', () => {
  assert.equal(joinHostPath('D:\\code\\liebian\\tasks', 'T-1'), 'D:\\code\\liebian\\tasks\\T-1')
  assert.equal(joinHostPath('D:/code/liebian/tasks/', 'T-1'), 'D:\\code\\liebian\\tasks\\T-1')
  assert.equal(joinHostPath('\\\\server\\share\\tasks', 'T-1'), '\\\\server\\share\\tasks\\T-1')
  assert.equal(joinHostPath('/srv/liebian/tasks/', 'T-1'), '/srv/liebian/tasks/T-1')
  assert.equal(joinHostPath('/tasks', 'T-1'), '/tasks/T-1')
})
